import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

test("loads the container contract and its production defaults", async () => {
  const config = await loadConfig({
    SOURCE_URL: "https://example.com/player?token=source-secret",
    RTMP_URL: "rtmps://stream.example.com/live/stream-secret",
  });

  assert.equal(
    config.sourceUrl.href,
    "https://example.com/player?token=source-secret",
  );
  assert.equal(
    config.rtmpUrl.href,
    "rtmps://stream.example.com/live/stream-secret",
  );
  assert.deepEqual(config.video, {
    width: 1280,
    height: 720,
    fps: 30,
    bitrateKbps: 3000,
  });
  assert.deepEqual(config.audio, {
    channels: 2,
    sampleRate: 48_000,
    bitrateKbps: 128,
  });
  assert.equal(config.pageLoadTimeoutMs, 30_000);
  assert.equal(config.pageWarmupMs, 5_000);
  assert.equal(config.healthPort, 3_000);
  assert.equal(config.logLevel, "info");
});

test("prefers a mounted RTMP secret by requiring exactly one URL source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-to-stream-config-"));
  const secretFile = join(directory, "rtmp-url");
  await writeFile(secretFile, "rtmp://localhost/live/from-file\n", {
    mode: 0o600,
  });

  const config = await loadConfig({
    SOURCE_URL: "http://localhost/page",
    RTMP_URL_FILE: secretFile,
  });

  assert.equal(config.rtmpUrl.href, "rtmp://localhost/live/from-file");

  await assert.rejects(
    loadConfig({
      SOURCE_URL: "http://localhost/page",
      RTMP_URL: "rtmp://localhost/live/direct",
      RTMP_URL_FILE: secretFile,
    }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "Set exactly one of RTMP_URL_FILE or RTMP_URL",
  );
});

test("rejects unsupported protocols and invalid numeric settings without leaking values", async () => {
  await assert.rejects(
    loadConfig({
      SOURCE_URL: "file:///etc/passwd",
      RTMP_URL: "https://example.com/not-rtmp/secret",
      VIDEO_BITRATE_KBPS: "unlimited",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message, "SOURCE_URL must use http: or https:");
      assert.doesNotMatch(error.message, /passwd|secret/);
      return true;
    },
  );
});
