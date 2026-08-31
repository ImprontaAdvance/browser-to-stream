import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type {
  EncoderResource,
  RuntimeResource,
  SessionRuntime,
} from "./runtime.js";

export type SessionState =
  "starting" | "streaming" | "reconnecting" | "stopping" | "stopped" | "failed";

export type SessionSnapshot = Readonly<{
  state: SessionState;
  ready: boolean;
  uptimeSeconds: number;
  reconnectCount: number;
  lastProgressAt: string | null;
}>;

type InfrastructureOutcome =
  | Readonly<{ type: "stop" }>
  | Readonly<{ type: "infrastructure-exit"; resource: RuntimeResource }>;

type EncoderOutcome =
  | InfrastructureOutcome
  | Readonly<{ type: "encoder-exit" }>
  | Readonly<{ type: "encoder-stall" }>
  | Readonly<{ type: "outage-deadline" }>;

type BackoffOutcome =
  | InfrastructureOutcome
  | Readonly<{ type: "backoff-complete" }>
  | Readonly<{ type: "outage-deadline" }>;

export class StreamingSession {
  private state: SessionState = "stopped";
  private startedAt: number | undefined;
  private lastProgressAt: number | undefined;
  private reconnectCount = 0;
  private runPromise: Promise<void> | undefined;
  private stopRequested = deferred<undefined>();
  private readonly lifecycleController = new AbortController();
  private resources: RuntimeResource[] = [];
  private encoder: EncoderResource | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: SessionRuntime,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    if (this.runPromise !== undefined) {
      throw new Error("StreamingSession can only be started once");
    }
    this.runPromise = this.run();
    return this.runPromise;
  }

  async stop(): Promise<void> {
    if (this.runPromise === undefined || this.state === "stopped") {
      return;
    }
    if (this.state !== "failed") {
      this.state = "stopping";
    }
    this.stopRequested.resolve(undefined);
    this.lifecycleController.abort();
    await this.runPromise;
  }

  snapshot(): SessionSnapshot {
    const now = this.runtime.now();
    const lastProgressAt = this.lastProgressAt;
    return Object.freeze({
      state: this.state,
      ready:
        this.state === "streaming" &&
        lastProgressAt !== undefined &&
        now - lastProgressAt <= 15_000,
      uptimeSeconds:
        this.startedAt === undefined
          ? 0
          : Math.max(0, Math.floor((now - this.startedAt) / 1_000)),
      reconnectCount: this.reconnectCount,
      lastProgressAt:
        lastProgressAt === undefined
          ? null
          : new Date(lastProgressAt).toISOString(),
    });
  }

  private async run(): Promise<void> {
    this.state = "starting";
    this.startedAt = this.runtime.now();
    this.logger.info("session_starting");

    try {
      const signal = this.lifecycleController.signal;
      this.resources.push(await this.runtime.startDisplay(this.config, signal));
      this.resources.push(await this.runtime.startAudio(this.config, signal));
      this.resources.push(await this.runtime.startBrowser(this.config, signal));
      const infrastructureOutcome = Promise.race<InfrastructureOutcome>([
        this.stopRequested.promise.then(() => ({ type: "stop" }) as const),
        ...this.resources.map((resource) =>
          resource.exited.then(
            () => ({ type: "infrastructure-exit", resource }) as const,
          ),
        ),
      ]);
      await this.runEncoderLoop(infrastructureOutcome);
    } catch (error) {
      if (!this.isStopping()) {
        this.state = "failed";
        this.logger.error("session_failed", { error });
        throw error;
      }
    } finally {
      await this.cleanup();
      if (this.state !== "failed") {
        this.state = "stopped";
        this.logger.info("session_stopped");
      }
    }
  }

  private async runEncoderLoop(
    infrastructureOutcome: Promise<InfrastructureOutcome>,
  ): Promise<void> {
    let retryAttempt = 0;
    let outageStartedAt: number | undefined;
    let outageController: AbortController | undefined;
    let outageDeadline:
      Promise<Readonly<{ type: "outage-deadline" }>> | undefined;

    try {
      while (!this.isStopping()) {
        const encoderStartedAt = this.runtime.now();
        let encoderProgressAt: number | undefined;
        const encoderHolder: { current?: EncoderResource } = {};
        const encoder = await this.runtime.startEncoder(
          this.config,
          () => {
            if (
              encoderHolder.current === undefined ||
              this.encoder !== encoderHolder.current
            ) {
              return;
            }
            encoderProgressAt = this.runtime.now();
            this.lastProgressAt = encoderProgressAt;
            this.state = "streaming";
            retryAttempt = 0;
            outageStartedAt = undefined;
            outageController?.abort();
            outageController = undefined;
            outageDeadline = undefined;
          },
          this.lifecycleController.signal,
        );
        encoderHolder.current = encoder;
        this.encoder = encoder;

        const watchdogController = new AbortController();
        const outcome = await Promise.race<EncoderOutcome>([
          infrastructureOutcome,
          encoder.exited.then(() => ({ type: "encoder-exit" }) as const),
          this.waitForEncoderStall(
            encoderStartedAt,
            () => encoderProgressAt,
            watchdogController.signal,
          ).then(() => ({ type: "encoder-stall" }) as const),
          ...(outageDeadline === undefined ? [] : [outageDeadline]),
        ]);
        watchdogController.abort();

        if (outcome.type === "stop") {
          return;
        }
        if (outcome.type === "infrastructure-exit") {
          throw new Error(`${outcome.resource.name} exited unexpectedly`);
        }
        if (outcome.type === "outage-deadline") {
          throw new Error("RTMP output was unavailable for 60 seconds");
        }

        if (outcome.type === "encoder-stall") {
          this.logger.warn("encoder_stalled");
          await encoder.stop(3_000);
        }
        this.encoder = undefined;

        const now = this.runtime.now();
        if (outageStartedAt === undefined) {
          outageStartedAt = now;
          outageController = new AbortController();
          outageDeadline = this.runtime
            .sleep(60_000, outageController.signal)
            .then(() => ({ type: "outage-deadline" }) as const)
            .catch(() => new Promise<never>(() => {}));
        }

        this.state = "reconnecting";
        this.reconnectCount += 1;
        retryAttempt += 1;
        const delays = [1_000, 2_000, 5_000] as const;
        const delayMs = delays[Math.min(retryAttempt - 1, 2)] ?? 5_000;
        this.logger.warn("encoder_reconnecting", {
          reconnectCount: this.reconnectCount,
          delayMs,
        });

        const activeOutageDeadline = outageDeadline;
        if (activeOutageDeadline === undefined) {
          throw new Error("RTMP outage deadline was not initialized");
        }
        const backoffController = new AbortController();
        const afterDelay = await Promise.race<BackoffOutcome>([
          infrastructureOutcome,
          this.runtime
            .sleep(delayMs, backoffController.signal)
            .then(() => ({ type: "backoff-complete" }) as const),
          activeOutageDeadline,
        ]);
        backoffController.abort();
        if (afterDelay.type === "infrastructure-exit") {
          throw new Error(`${afterDelay.resource.name} exited unexpectedly`);
        }
        if (afterDelay.type === "outage-deadline") {
          throw new Error("RTMP output was unavailable for 60 seconds");
        }
        if (this.isStopping()) {
          return;
        }
      }
    } finally {
      outageController?.abort();
    }
  }

  private isStopping(): boolean {
    return this.state === "stopping";
  }

  private async waitForEncoderStall(
    encoderStartedAt: number,
    progressAt: () => number | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      const lastActivityAt = progressAt() ?? encoderStartedAt;
      const remainingMs = 15_000 - (this.runtime.now() - lastActivityAt);
      if (remainingMs <= 0) {
        return;
      }
      await this.runtime.sleep(remainingMs, signal);
    }
  }

  private async cleanup(): Promise<void> {
    const cleanupOrder: ReadonlyArray<
      readonly [RuntimeResource | undefined, number]
    > = [
      [this.encoder, 3_000],
      [this.resources[2], 3_000],
      [this.resources[1], 2_000],
      [this.resources[0], 2_000],
    ];

    for (const [resource, gracePeriodMs] of cleanupOrder) {
      if (resource === undefined) {
        continue;
      }
      try {
        await resource.stop(gracePeriodMs);
      } catch (error) {
        this.logger.warn("resource_stop_failed", {
          resource: resource.name,
          error,
        });
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
