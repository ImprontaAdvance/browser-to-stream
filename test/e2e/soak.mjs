import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const durationSeconds = positiveInteger(
  process.env.SOAK_DURATION_SECONDS,
  7_200,
);
const sampleSeconds = positiveInteger(process.env.SOAK_SAMPLE_SECONDS, 15);
const segmentSeconds = positiveInteger(process.env.SOAK_SEGMENT_SECONDS, 60);
const image = process.env.E2E_IMAGE ?? "browser-to-stream:dev";
const suffix = randomUUID().slice(0, 8);
const network = `browser-to-stream-soak-${suffix}`;
const fixture = `browser-to-stream-soak-fixture-${suffix}`;
const receiver = `browser-to-stream-soak-receiver-${suffix}`;
const application = `browser-to-stream-soak-app-${suffix}`;
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = await mkdtemp(
  join(tmpdir(), "browser-to-stream-soak-"),
);
const applicationCodeMount = process.env.E2E_DIST_DIRECTORY
  ? ["--volume", `${resolve(process.env.E2E_DIST_DIRECTORY)}:/app/dist:ro`]
  : [];
const memorySamples = [];
const fixtureServerSource = `
  import {createServer} from 'node:http';
  import {readFile} from 'node:fs/promises';
  const page = await readFile('/fixture/fixture.html');
  createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(page);
  }).listen(8080, '0.0.0.0');
`;
await chmod(outputDirectory, 0o777);

try {
  docker(["network", "create", network]);
  docker([
    "run",
    "--detach",
    "--name",
    fixture,
    "--network",
    network,
    "--volume",
    `${fixtureDirectory}:/fixture:ro`,
    image,
    "node",
    "--input-type=module",
    "--eval",
    fixtureServerSource,
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    receiver,
    "--network",
    network,
    "--volume",
    `${outputDirectory}:/capture`,
    image,
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "info",
    "-stats_period",
    String(sampleSeconds),
    "-listen",
    "1",
    "-i",
    "rtmp://0.0.0.0:1935/live/soak",
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    String(segmentSeconds),
    "-segment_wrap",
    "3",
    "-reset_timestamps",
    "1",
    "-y",
    "/capture/soak-%01d.flv",
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    application,
    "--network",
    network,
    ...applicationCodeMount,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--shm-size",
    "1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--env",
    `SOURCE_URL=http://${fixture}:8080/fixture.html`,
    "--env",
    `RTMP_URL=rtmp://${receiver}:1935/live/soak`,
    "--env",
    "PAGE_WARMUP_MS=1000",
    image,
  ]);

  await waitForReady(90_000);
  const initialChromePid = findChromePid();
  assert.ok(initialChromePid, "Chrome process was not found");

  const deadline = Date.now() + durationSeconds * 1_000;
  while (Date.now() < deadline) {
    const status = readStatus();
    assert.equal(status.ready, true, "stream lost readiness during soak");
    assert.equal(status.state, "streaming");
    assert.equal(status.reconnectCount, 0, "FFmpeg reconnected during soak");
    assert.equal(
      findChromePid(),
      initialChromePid,
      "Chrome restarted during soak",
    );

    const resourceUsage = docker([
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}|{{.MemUsage}}",
      application,
    ]);
    const [, memoryUsage] = resourceUsage.split("|");
    const memoryBytes = parseMemoryBytes(memoryUsage.split("/")[0].trim());
    memorySamples.push(memoryBytes);
    assert.ok(
      memoryBytes < 1.9 * 1024 ** 3,
      "memory approached its 2 GiB limit",
    );

    await delay(Math.min(sampleSeconds * 1_000, deadline - Date.now()));
  }

  const shutdownStartedAt = Date.now();
  docker(["stop", "--time", "10", application]);
  assert.ok(Date.now() - shutdownStartedAt <= 10_500);
  await waitForStopped(receiver, 10_000);

  const applicationState = JSON.parse(
    docker(["inspect", "--format", "{{json .State}}", application]),
  );
  assert.equal(applicationState.ExitCode, 0);
  assert.equal(applicationState.Pid, 0);

  const applicationLogs = combinedLogs(application);
  assert.doesNotMatch(applicationLogs, /session_failed|encoder_reconnecting/);
  assertMemoryStable(memorySamples);
  assertEncoderSpeed(combinedLogs(receiver));
  await assertAudioVideoDrift();

  process.stdout.write(
    `container soak test passed (${durationSeconds}s, ${memorySamples.length} samples)\n`,
  );
} catch (error) {
  dumpLogs(application);
  dumpLogs(receiver);
  throw error;
} finally {
  dockerResult(["rm", "--force", application], false);
  dockerResult(["rm", "--force", receiver], false);
  dockerResult(["rm", "--force", fixture], false);
  dockerResult(["network", "rm", network], false);
  await rm(outputDirectory, { recursive: true, force: true });
}

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = dockerResult(
      [
        "exec",
        application,
        "node",
        "--input-type=module",
        "--eval",
        "const response=await fetch('http://127.0.0.1:3000/readyz'); if(!response.ok) process.exit(1)",
      ],
      false,
    );
    if (result.status === 0) return;
    if (!isRunning(application)) {
      throw new Error("application exited before becoming ready");
    }
    await delay(500);
  }
  throw new Error("application did not become ready within 90 seconds");
}

async function waitForStopped(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(container)) return;
    await delay(250);
  }
  throw new Error(`${container} did not stop within ${timeoutMs} ms`);
}

function readStatus() {
  return JSON.parse(
    docker([
      "exec",
      application,
      "node",
      "--input-type=module",
      "--eval",
      "const response=await fetch('http://127.0.0.1:3000/status'); console.log(await response.text())",
    ]),
  );
}

function findChromePid() {
  return docker([
    "exec",
    application,
    "node",
    "--input-type=module",
    "--eval",
    `
      const {readdirSync, readFileSync} = await import('node:fs');
      for (const entry of readdirSync('/proc')) {
        if (!/^\\d+$/.test(entry)) continue;
        try {
          const command = readFileSync('/proc/' + entry + '/cmdline', 'utf8');
          if (command.includes('/chrome-linux64/chrome') && !command.includes('--type=')) {
            console.log(entry);
            break;
          }
        } catch {}
      }
    `,
  ]);
}

function assertMemoryStable(samples) {
  assert.ok(samples.length >= 2, "not enough memory samples");
  const windowSize = Math.max(1, Math.floor(samples.length / 8));
  const initialAverage = average(samples.slice(0, windowSize));
  const finalAverage = average(samples.slice(-windowSize));
  assert.ok(
    finalAverage - initialAverage < 256 * 1024 ** 2,
    "memory grew by more than 256 MiB",
  );
}

function assertEncoderSpeed(logs) {
  const speeds = [...logs.matchAll(/speed=\s*([\d.]+)x/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(speeds.length > 0, "receiver did not report stream speed");
  const recentSpeeds = speeds.slice(-Math.min(5, speeds.length));
  assert.ok(
    average(recentSpeeds) >= 0.98,
    `average recent FFmpeg speed was ${average(recentSpeeds).toFixed(3)}x`,
  );
}

async function assertAudioVideoDrift() {
  const segmentFiles = await readdir(outputDirectory);
  const candidates = await Promise.all(
    segmentFiles
      .filter((file) => /^soak-\d+\.flv$/.test(file))
      .map(async (file) => ({
        file,
        modifiedAt: (await stat(join(outputDirectory, file))).mtimeMs,
      })),
  );
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  assert.ok(candidates.length > 0, "soak receiver produced no segments");
  const mediaFile = candidates[0].file;
  const videoEnd = lastPacketTimestamp(mediaFile, "v:0");
  const audioEnd = lastPacketTimestamp(mediaFile, "a:0");
  assert.ok(
    Math.abs(videoEnd - audioEnd) < 0.25,
    `A/V drift was ${Math.abs(videoEnd - audioEnd).toFixed(3)}s`,
  );
}

function lastPacketTimestamp(file, selector) {
  const timestamps = docker([
    "run",
    "--rm",
    "--volume",
    `${outputDirectory}:/capture:ro`,
    "--entrypoint",
    "ffprobe",
    image,
    "-v",
    "error",
    "-select_streams",
    selector,
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    `/capture/${file}`,
  ])
    .split("\n")
    .filter(Boolean);
  const result = Number(timestamps.at(-1));
  assert.ok(Number.isFinite(result), `${selector} timestamps are missing`);
  return result;
}

function parseMemoryBytes(value) {
  const match = /^([\d.]+)([KMGT]iB)$/.exec(value);
  assert.ok(match, `unrecognized Docker memory value: ${value}`);
  const powers = { KiB: 1, MiB: 2, GiB: 3, TiB: 4 };
  return Number(match[1]) * 1024 ** powers[match[2]];
}

function positiveInteger(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function combinedLogs(container) {
  const logs = dockerResult(["logs", container]);
  return logs.stdout + logs.stderr;
}

function isRunning(container) {
  return (
    dockerResult(
      ["inspect", "--format", "{{.State.Running}}", container],
      false,
    ).stdout.trim() === "true"
  );
}

function docker(arguments_, check = true) {
  return dockerResult(arguments_, check).stdout.trim();
}

function dockerResult(arguments_, check = true) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (check && result.status !== 0) {
    throw new Error(
      `docker ${arguments_.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function dumpLogs(container) {
  const logs = dockerResult(["logs", container], false);
  if (logs.stdout || logs.stderr) {
    process.stderr.write(
      `\n--- ${container} logs ---\n${logs.stdout}${logs.stderr}`,
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
