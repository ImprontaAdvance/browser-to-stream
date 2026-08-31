import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import puppeteer, { type Browser, type Page } from "puppeteer";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { publicUrl } from "./logger.js";

export type RuntimeExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export interface RuntimeResource {
  readonly name: string;
  readonly exited: Promise<RuntimeExit>;
  stop(gracePeriodMs: number): Promise<void>;
}

export type EncoderResource = RuntimeResource;

export interface SessionRuntime {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  startDisplay(
    config: AppConfig,
    signal: AbortSignal,
  ): Promise<RuntimeResource>;
  startAudio(config: AppConfig, signal: AbortSignal): Promise<RuntimeResource>;
  startBrowser(
    config: AppConfig,
    signal: AbortSignal,
  ): Promise<RuntimeResource>;
  startEncoder(
    config: AppConfig,
    onProgress: () => void,
    signal: AbortSignal,
  ): Promise<EncoderResource>;
}

const displayName = ":99";
const pulseSinkName = "browser";

export class RealSessionRuntime implements SessionRuntime {
  private readonly runtimeDirectory = `/tmp/browser-to-stream-${process.pid}`;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly logger: Logger) {
    this.environment = {
      ...process.env,
      DISPLAY: displayName,
      XDG_RUNTIME_DIR: this.runtimeDirectory,
      XDG_CONFIG_HOME: join(this.runtimeDirectory, "config"),
      PULSE_SERVER: `unix:${this.runtimeDirectory}/pulse/native`,
      PULSE_SINK: pulseSinkName,
    };
  }

  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await sleep(milliseconds);
      return;
    }
    await sleep(milliseconds, undefined, { signal });
  }

  async startDisplay(
    config: AppConfig,
    signal: AbortSignal,
  ): Promise<RuntimeResource> {
    signal.throwIfAborted();
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const child = this.spawnLogged(
      "display",
      "Xvfb",
      [
        displayName,
        "-screen",
        "0",
        `${config.video.width}x${config.video.height}x24`,
        "-nolisten",
        "tcp",
        "-noreset",
        "-ac",
      ],
      this.environment,
    );
    const resource = new ChildProcessResource(
      "display",
      child,
      "SIGTERM",
      async () => {
        await rm(this.runtimeDirectory, { recursive: true, force: true });
      },
    );

    try {
      await waitForCommand(
        "xdpyinfo",
        ["-display", displayName],
        this.environment,
        10_000,
        signal,
      );
      this.logger.info("display_ready", {
        display: displayName,
        width: config.video.width,
        height: config.video.height,
      });
      return resource;
    } catch (error) {
      await resource.stop(1_000);
      throw new Error("Virtual display failed to become ready", {
        cause: error,
      });
    }
  }

  async startAudio(
    _config: AppConfig,
    signal: AbortSignal,
  ): Promise<RuntimeResource> {
    signal.throwIfAborted();
    await mkdir(join(this.runtimeDirectory, "config", "pulse"), {
      recursive: true,
      mode: 0o700,
    });
    const child = this.spawnLogged(
      "audio",
      "pulseaudio",
      [
        "--daemonize=no",
        "--exit-idle-time=-1",
        "--log-target=stderr",
        "--disallow-exit",
      ],
      this.environment,
    );
    const resource = new ChildProcessResource("audio", child, "SIGTERM");

    try {
      await waitForCommand("pactl", ["info"], this.environment, 10_000, signal);
      signal.throwIfAborted();
      await runCommand(
        "pactl",
        [
          "load-module",
          "module-null-sink",
          `sink_name=${pulseSinkName}`,
          "sink_properties=device.description=Browser",
        ],
        this.environment,
      );
      await runCommand(
        "pactl",
        ["set-default-sink", pulseSinkName],
        this.environment,
      );
      await runCommand(
        "pactl",
        ["set-sink-mute", pulseSinkName, "0"],
        this.environment,
      );
      this.logger.info("audio_ready", { source: `${pulseSinkName}.monitor` });
      return resource;
    } catch (error) {
      await resource.stop(1_000);
      throw new Error("PulseAudio failed to become ready", { cause: error });
    }
  }

  async startBrowser(
    config: AppConfig,
    signal: AbortSignal,
  ): Promise<RuntimeResource> {
    let browser: Browser | undefined;
    const closeOnAbort = () => {
      void browser?.close().catch(() => {});
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      signal.throwIfAborted();
      const executablePath =
        process.env.CHROME_BIN ?? (await puppeteer.executablePath());
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        executablePath,
        userDataDir: join(this.runtimeDirectory, "chrome-profile"),
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ignoreDefaultArgs: [
          "--mute-audio",
          "--disable-dev-shm-usage",
          "about:blank",
        ],
        env: this.environment,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--no-first-run",
          "--no-default-browser-check",
          "--autoplay-policy=no-user-gesture-required",
          "--kiosk",
          `--app=${config.sourceUrl.href}`,
          "--window-position=0,0",
          `--window-size=${config.video.width},${config.video.height}`,
          "--force-device-scale-factor=1",
          "--ozone-platform=x11",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });

      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      await setBrowserWindow(page, config);
      await navigateWithRetries(page, config, this.logger, (milliseconds) =>
        this.sleep(milliseconds, signal),
      );
      await page.bringToFront();
      await this.sleep(config.pageWarmupMs, signal);
      signal.throwIfAborted();

      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      if (
        viewport.width !== config.video.width ||
        viewport.height !== config.video.height
      ) {
        throw new Error(
          `Browser viewport is ${viewport.width}x${viewport.height}; expected ${config.video.width}x${config.video.height}`,
        );
      }

      this.logger.info("browser_ready", {
        source: publicUrl(config.sourceUrl),
      });
      signal.removeEventListener("abort", closeOnAbort);
      return new BrowserResource(browser, page);
    } catch (error) {
      signal.removeEventListener("abort", closeOnAbort);
      if (browser !== undefined) {
        await browser.close().catch(() => {});
      }
      throw new Error("Browser failed to become ready", { cause: error });
    }
  }

  async startEncoder(
    config: AppConfig,
    onProgress: () => void,
    signal: AbortSignal,
  ): Promise<EncoderResource> {
    signal.throwIfAborted();
    const child = spawn("ffmpeg", buildFfmpegArguments(config), {
      env: this.environment,
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    logLines(child.stderr, (message) => {
      this.logger.warn("ffmpeg_output", { message });
    });

    const progressStream = child.stdio[3];
    if (!(progressStream instanceof Readable)) {
      child.kill("SIGKILL");
      throw new Error("FFmpeg progress pipe was not created");
    }

    let lastOutputTimestamp = -1;
    logLines(progressStream, (line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return;
      }
      const key = line.slice(0, separator);
      if (key !== "out_time_us" && key !== "out_time_ms") {
        return;
      }
      const outputTimestamp = Number(line.slice(separator + 1));
      if (
        Number.isFinite(outputTimestamp) &&
        outputTimestamp > lastOutputTimestamp
      ) {
        lastOutputTimestamp = outputTimestamp;
        onProgress();
      }
    });

    this.logger.info("encoder_started", {
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      bitrateKbps: config.video.bitrateKbps,
    });
    return new ChildProcessResource("encoder", child, "SIGINT");
  }

  private spawnLogged(
    name: string,
    command: string,
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): ChildProcess {
    const child = spawn(command, arguments_, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    logLines(child.stderr, (message) => {
      this.logger.debug("runtime_output", { resource: name, message });
    });
    return child;
  }
}

class ChildProcessResource implements RuntimeResource {
  readonly exited: Promise<RuntimeExit>;
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly child: ChildProcess,
    private readonly gracefulSignal: NodeJS.Signals,
    private readonly afterStop?: () => Promise<void>,
  ) {
    this.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (exit: RuntimeExit) => {
        if (!settled) {
          settled = true;
          resolve(exit);
        }
      };
      child.once("error", () => finish({ code: 1, signal: null }));
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
  }

  async stop(gracePeriodMs: number): Promise<void> {
    if (this.cleanupPromise !== undefined) {
      return this.cleanupPromise;
    }
    this.cleanupPromise = this.stopOnce(gracePeriodMs);
    return this.cleanupPromise;
  }

  private async stopOnce(gracePeriodMs: number): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(this.gracefulSignal);
      const exitedGracefully = await Promise.race([
        this.exited.then(() => true),
        sleep(gracePeriodMs).then(() => false),
      ]);
      if (!exitedGracefully) {
        this.child.kill("SIGKILL");
        await Promise.race([this.exited, sleep(1_000)]);
      }
    }
    await this.afterStop?.();
  }
}

class BrowserResource implements RuntimeResource {
  readonly name = "browser";
  readonly exited: Promise<RuntimeExit>;
  private resolveExit!: (exit: RuntimeExit) => void;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly browser: Browser,
    page: Page,
  ) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    browser.once("disconnected", () => {
      this.resolveExit({ code: 1, signal: null });
    });
    page.once("error", () => {
      this.resolveExit({ code: 1, signal: null });
    });
    page.once("close", () => {
      this.resolveExit({ code: 1, signal: null });
    });
  }

  async stop(gracePeriodMs: number): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.stopPromise = (async () => {
      const closed = await Promise.race([
        this.browser.close().then(() => true),
        sleep(gracePeriodMs).then(() => false),
      ]).catch(() => false);
      if (!closed) {
        this.browser.process()?.kill("SIGKILL");
      }
    })();
    return this.stopPromise;
  }
}

async function setBrowserWindow(page: Page, config: AppConfig): Promise<void> {
  const session = await page.createCDPSession();
  const { windowId } = await session.send("Browser.getWindowForTarget");
  await session.send("Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: 0,
      top: 0,
      width: config.video.width,
      height: config.video.height,
      windowState: "normal",
    },
  });
  await page.setViewport({
    width: config.video.width,
    height: config.video.height,
    deviceScaleFactor: 1,
  });
}

async function navigateWithRetries(
  page: Page,
  config: AppConfig,
  logger: Logger,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(config.sourceUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: config.pageLoadTimeoutMs,
      });
      return;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      const delayMs = attempt * 1_000;
      logger.warn("browser_navigation_retry", { attempt, delayMs });
      await wait(delayMs);
    }
  }
}

async function waitForCommand(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await runCommand(command, arguments_, environment);
      return;
    } catch (error) {
      lastError = error;
      await sleep(100, undefined, { signal });
    }
  }
  throw new Error(`${command} readiness timed out`, { cause: lastError });
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`${command} exited with code ${code}: ${stderr.trim()}`),
        );
      }
    });
  });
}

function logLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): void {
  if (stream === null) {
    return;
  }
  const lines = createInterface({ input: stream });
  lines.on("line", onLine);
}

export function buildFfmpegArguments(config: AppConfig): string[] {
  const videoBitrate = `${config.video.bitrateKbps}k`;
  const videoBuffer = `${config.video.bitrateKbps * 2}k`;

  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-thread_queue_size",
    "512",
    "-use_wallclock_as_timestamps",
    "1",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(config.video.fps),
    "-video_size",
    `${config.video.width}x${config.video.height}`,
    "-i",
    ":99.0+0,0",
    "-thread_queue_size",
    "512",
    "-use_wallclock_as_timestamps",
    "1",
    "-f",
    "pulse",
    "-i",
    "browser.monitor",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "main",
    "-level:v",
    "3.1",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(config.video.fps),
    "-fps_mode",
    "cfr",
    "-g",
    String(config.video.fps * 2),
    "-keyint_min",
    String(config.video.fps * 2),
    "-sc_threshold",
    "0",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    videoBuffer,
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    `${config.audio.bitrateKbps}k`,
    "-ar",
    String(config.audio.sampleRate),
    "-ac",
    String(config.audio.channels),
    "-af",
    "aresample=async=1:first_pts=0",
    "-flvflags",
    "no_duration_filesize",
    "-flush_packets",
    "1",
    "-progress",
    "pipe:3",
    "-f",
    "flv",
    config.rtmpUrl.href,
  ];
}
