import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";
import type {
  EncoderResource,
  RuntimeExit,
  RuntimeResource,
  SessionRuntime,
} from "../src/runtime.ts";
import { StreamingSession } from "../src/streaming-session.ts";

test("becomes ready on encoder progress and stops resources in reverse order", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new FakeRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  await waitUntil(() => runtime.progress !== undefined);

  assert.equal(session.snapshot().state, "starting");
  assert.equal(session.snapshot().ready, false);

  runtime.progress!();
  assert.equal(session.snapshot().state, "streaming");
  assert.equal(session.snapshot().ready, true);
  assert.equal(session.snapshot().lastProgressAt, "1970-01-01T00:00:01.000Z");

  await session.stop();
  await running;

  assert.equal(session.snapshot().state, "stopped");
  assert.deepEqual(runtime.started, ["display", "audio", "browser", "encoder"]);
  assert.deepEqual(runtime.stopped, ["encoder", "browser", "audio", "display"]);
});

test("reconnects only the encoder after a transient RTMP failure", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new FakeRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  void running.catch(() => {});
  await waitUntil(() => runtime.encoders.length === 1);
  runtime.progress!();

  runtime.encoders[0]!.fail();
  await waitUntil(() => runtime.sleepFor(1_000) !== undefined);

  assert.equal(session.snapshot().state, "reconnecting");
  assert.equal(session.snapshot().ready, false);
  assert.equal(session.snapshot().reconnectCount, 1);
  assert.equal(runtime.started.filter((name) => name === "browser").length, 1);

  runtime.sleepFor(1_000)!.resolve();
  await waitUntil(() => runtime.encoders.length === 2);
  runtime.progress!();

  assert.equal(session.snapshot().state, "streaming");
  assert.equal(session.snapshot().ready, true);
  assert.equal(runtime.started.filter((name) => name === "browser").length, 1);

  await session.stop();
  await running;
});

test("restarts a live encoder that has made no progress for 15 seconds", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new FakeRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  void running.catch(() => {});
  await waitUntil(() => runtime.sleepFor(15_000) !== undefined);

  runtime.sleepFor(15_000)!.resolve();
  await waitUntil(() => runtime.sleepFor(1_000) !== undefined);

  assert.equal(session.snapshot().state, "reconnecting");
  assert.equal(session.snapshot().reconnectCount, 1);
  assert.equal(runtime.encoders[0]!.stopCount, 1);

  await session.stop();
  await running;
});

test("fails when RTMP has remained unavailable for 60 seconds", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new FakeRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  void running.catch(() => {});
  await waitUntil(() => runtime.encoders.length === 1);
  runtime.progress!();
  runtime.encoders[0]!.fail();
  await waitUntil(() => runtime.sleepFor(60_000) !== undefined);

  runtime.sleepFor(60_000)!.resolve();

  await assert.rejects(running, /RTMP output was unavailable for 60 seconds/);
  assert.equal(session.snapshot().state, "failed");
  assert.equal(runtime.started.filter((name) => name === "browser").length, 1);
});

test("cancels the progress watchdog during graceful shutdown", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new FakeRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  await waitUntil(() => runtime.sleepFor(15_000) !== undefined);
  const watchdog = runtime.sleepFor(15_000)!;

  await session.stop();
  await running;

  assert.equal(watchdog.aborted, true);
});

test("cancels an in-flight startup step before cleaning up", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player",
    RTMP_URL: "rtmp://localhost/live/test",
  });
  const runtime = new CancelableStartupRuntime();
  const session = new StreamingSession(config, runtime, silentLogger);

  const running = session.start();
  await waitUntil(() => runtime.started.includes("audio"));

  let stopSettled = false;
  const stopping = session.stop().then(() => {
    stopSettled = true;
  });
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(stopSettled, true);
  await stopping;
  await running;
  assert.equal(session.snapshot().state, "stopped");
  assert.deepEqual(runtime.stopped, ["display"]);
});

class FakeResource implements RuntimeResource {
  readonly exited: Promise<RuntimeExit>;
  private resolveExit!: (exit: RuntimeExit) => void;

  constructor(
    readonly name: string,
    private readonly stopped: string[],
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  stopCount = 0;

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.stopped.push(this.name);
    this.resolveExit({ code: 0, signal: null });
  }

  fail(code = 1): void {
    this.resolveExit({ code, signal: null });
  }
}

class FakeRuntime implements SessionRuntime {
  nowMs = 1_000;
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly encoders: FakeResource[] = [];
  readonly sleeps: Array<{
    milliseconds: number;
    resolve: () => void;
    aborted: boolean;
  }> = [];
  progress: (() => void) | undefined;

  now(): number {
    return this.nowMs;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const pending = {
        milliseconds,
        aborted: false,
        resolve: () => {
          this.nowMs += milliseconds;
          resolve();
        },
      };
      this.sleeps.push(pending);
      signal?.addEventListener(
        "abort",
        () => {
          pending.aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  sleepFor(
    milliseconds: number,
  ):
    | { milliseconds: number; resolve: () => void; aborted: boolean }
    | undefined {
    return this.sleeps.find(
      (sleep) => sleep.milliseconds === milliseconds && !sleep.aborted,
    );
  }

  async startDisplay(): Promise<RuntimeResource> {
    return this.resource("display");
  }

  async startAudio(): Promise<RuntimeResource> {
    return this.resource("audio");
  }

  async startBrowser(): Promise<RuntimeResource> {
    return this.resource("browser");
  }

  async startEncoder(
    _config: unknown,
    onProgress: () => void,
  ): Promise<EncoderResource> {
    this.progress = onProgress;
    const encoder = this.resource("encoder");
    this.encoders.push(encoder);
    return encoder;
  }

  private resource(name: string): FakeResource {
    this.started.push(name);
    return new FakeResource(name, this.stopped);
  }
}

class CancelableStartupRuntime extends FakeRuntime {
  override async startAudio(
    _config?: unknown,
    signal?: AbortSignal,
  ): Promise<RuntimeResource> {
    this.started.push("audio");
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await waitForImmediate();
  }
  assert.fail("condition was not reached");
}
