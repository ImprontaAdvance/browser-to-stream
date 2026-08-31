import { readFile } from "node:fs/promises";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppConfig = Readonly<{
  sourceUrl: URL;
  rtmpUrl: URL;
  video: Readonly<{
    width: 1280;
    height: 720;
    fps: 30;
    bitrateKbps: number;
  }>;
  audio: Readonly<{
    channels: 2;
    sampleRate: 48_000;
    bitrateKbps: 128;
  }>;
  pageLoadTimeoutMs: number;
  pageWarmupMs: number;
  healthPort: number;
  logLevel: LogLevel;
}>;

type Environment = Record<string, string | undefined>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export async function loadConfig(environment: Environment): Promise<AppConfig> {
  const sourceUrl = parseUrl(
    required(environment.SOURCE_URL, "SOURCE_URL is required"),
    "SOURCE_URL",
    new Set(["http:", "https:"]),
  );

  const rtmpUrlFromEnvironment = nonEmpty(environment.RTMP_URL);
  const rtmpUrlFile = nonEmpty(environment.RTMP_URL_FILE);
  if ((rtmpUrlFromEnvironment === undefined) === (rtmpUrlFile === undefined)) {
    throw new ConfigError("Set exactly one of RTMP_URL_FILE or RTMP_URL");
  }

  const rawRtmpUrl =
    rtmpUrlFile === undefined
      ? required(rtmpUrlFromEnvironment, "RTMP_URL is required")
      : required(
          (await readFile(rtmpUrlFile, "utf8")).trim(),
          "RTMP_URL_FILE must not be empty",
        );
  const rtmpUrl = parseUrl(
    rawRtmpUrl,
    rtmpUrlFile === undefined ? "RTMP_URL" : "RTMP_URL_FILE",
    new Set(["rtmp:", "rtmps:"]),
  );

  return Object.freeze({
    sourceUrl,
    rtmpUrl,
    video: Object.freeze({
      width: 1280 as const,
      height: 720 as const,
      fps: 30 as const,
      bitrateKbps: integerSetting(
        environment.VIDEO_BITRATE_KBPS,
        "VIDEO_BITRATE_KBPS",
        3_000,
        500,
        6_000,
      ),
    }),
    audio: Object.freeze({
      channels: 2 as const,
      sampleRate: 48_000 as const,
      bitrateKbps: 128 as const,
    }),
    pageLoadTimeoutMs: integerSetting(
      environment.PAGE_LOAD_TIMEOUT_MS,
      "PAGE_LOAD_TIMEOUT_MS",
      30_000,
      1_000,
      120_000,
    ),
    pageWarmupMs: integerSetting(
      environment.PAGE_WARMUP_MS,
      "PAGE_WARMUP_MS",
      5_000,
      0,
      60_000,
    ),
    healthPort: integerSetting(
      environment.HEALTH_PORT,
      "HEALTH_PORT",
      3_000,
      1,
      65_535,
    ),
    logLevel: logLevel(environment.LOG_LEVEL),
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function required(value: string | undefined, message: string): string {
  const result = nonEmpty(value);
  if (result === undefined) {
    throw new ConfigError(message);
  }
  return result;
}

function parseUrl(
  value: string,
  setting: string,
  protocols: ReadonlySet<string>,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${setting} must be a valid URL`);
  }

  if (!protocols.has(url.protocol)) {
    const expected = [...protocols].map((protocol) => protocol).join(" or ");
    throw new ConfigError(`${setting} must use ${expected}`);
  }
  return url;
}

function integerSetting(
  value: string | undefined,
  setting: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = nonEmpty(value);
  if (normalized === undefined) {
    return defaultValue;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError(
      `${setting} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function logLevel(value: string | undefined): LogLevel {
  const normalized = nonEmpty(value) ?? "info";
  if (
    normalized !== "debug" &&
    normalized !== "info" &&
    normalized !== "warn" &&
    normalized !== "error"
  ) {
    throw new ConfigError("LOG_LEVEL must be debug, info, warn, or error");
  }
  return normalized;
}
