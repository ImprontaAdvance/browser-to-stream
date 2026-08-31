import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const image = process.env.E2E_IMAGE ?? "browser-to-stream:dev";
const suffix = randomUUID().slice(0, 8);
const network = `browser-to-stream-resilience-${suffix}`;
const fixture = `browser-to-stream-resilience-fixture-${suffix}`;
const receiver = `browser-to-stream-resilience-receiver-${suffix}`;
const application = `browser-to-stream-resilience-app-${suffix}`;
const terminalApplication = `browser-to-stream-terminal-app-${suffix}`;
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = await mkdtemp(
  join(tmpdir(), "browser-to-stream-resilience-"),
);
const applicationCodeMount = process.env.E2E_DIST_DIRECTORY
  ? ["--volume", `${resolve(process.env.E2E_DIST_DIRECTORY)}:/app/dist:ro`]
  : [];
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

  startReceiver("initial.flv");
  startApplication(application);
  await waitForReadiness(application, true, 90_000);
  const chromePid = findChromePid(application);
  assert.ok(chromePid, "Chrome process was not found");

  docker(["rm", "--force", receiver]);
  await waitForReadiness(application, false, 20_000);
  startReceiver("recovered.flv");
  await waitForReadiness(application, true, 55_000);
  await delay(4_000);

  assert.equal(
    findChromePid(application),
    chromePid,
    "Chrome restarted during RTMP recovery",
  );
  const status = readStatus(application);
  assert.equal(status.state, "streaming");
  assert.ok(status.reconnectCount > 0, "reconnect count did not advance");

  const shutdownStartedAt = Date.now();
  docker(["stop", "--time", "10", application]);
  assert.ok(
    Date.now() - shutdownStartedAt <= 10_500,
    "graceful shutdown exceeded 10 seconds",
  );
  assertStoppedCleanly(application, 0);
  await waitForStopped(receiver, 10_000);
  assertValidRecoveryMedia();

  docker(["rm", "--force", receiver]);
  startReceiver("terminal-outage.flv");
  startApplication(terminalApplication);
  await waitForReadiness(terminalApplication, true, 90_000);
  docker(["rm", "--force", receiver]);

  const outageStartedAt = Date.now();
  await waitForStopped(terminalApplication, 75_000);
  const outageDuration = Date.now() - outageStartedAt;
  assert.ok(outageDuration >= 58_000, "terminal outage failed too early");
  assert.ok(outageDuration <= 70_000, "terminal outage failed too late");
  assertStoppedCleanly(terminalApplication, 1);

  const terminalLogResult = dockerResult(["logs", terminalApplication]);
  const terminalLogs = terminalLogResult.stdout + terminalLogResult.stderr;
  assert.doesNotMatch(terminalLogs, /secret-stream-key|secret-token/);
  assert.match(terminalLogs, /RTMP output was unavailable for 60 seconds/);

  process.stdout.write("container resilience test passed\n");
} catch (error) {
  dumpLogs(application);
  dumpLogs(terminalApplication);
  dumpLogs(receiver);
  throw error;
} finally {
  dockerResult(["rm", "--force", application], false);
  dockerResult(["rm", "--force", terminalApplication], false);
  dockerResult(["rm", "--force", receiver], false);
  dockerResult(["rm", "--force", fixture], false);
  dockerResult(["network", "rm", network], false);
  await rm(outputDirectory, { recursive: true, force: true });
}

function startReceiver(outputName) {
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
    "warning",
    "-listen",
    "1",
    "-i",
    "rtmp://0.0.0.0:1935/live/secret-stream-key?auth=secret-token",
    "-c",
    "copy",
    "-y",
    `/capture/${outputName}`,
  ]);
}

function startApplication(name) {
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    ...applicationCodeMount,
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
    `RTMP_URL=rtmp://${receiver}:1935/live/secret-stream-key?auth=secret-token`,
    "--env",
    "PAGE_WARMUP_MS=1000",
    image,
  ]);
}

function findChromePid(container) {
  return docker([
    "exec",
    container,
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

function readStatus(container) {
  return JSON.parse(
    docker([
      "exec",
      container,
      "node",
      "--input-type=module",
      "--eval",
      "const response=await fetch('http://127.0.0.1:3000/status'); console.log(await response.text())",
    ]),
  );
}

async function waitForReadiness(container, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const expectedStatus = expected ? 200 : 503;
    const result = dockerResult(
      [
        "exec",
        container,
        "node",
        "--input-type=module",
        "--eval",
        `const response=await fetch('http://127.0.0.1:3000/readyz'); if(response.status!==${expectedStatus}) process.exit(1)`,
      ],
      false,
    );
    if (result.status === 0) {
      return;
    }
    if (!isRunning(container)) {
      throw new Error(
        `application exited while waiting for readiness=${expected}`,
      );
    }
    await delay(500);
  }
  throw new Error(`readiness=${expected} was not reached in time`);
}

async function waitForStopped(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(container)) {
      return;
    }
    await delay(250);
  }
  throw new Error(`${container} did not stop within ${timeoutMs} ms`);
}

function isRunning(container) {
  return (
    dockerResult(
      ["inspect", "--format", "{{.State.Running}}", container],
      false,
    ).stdout.trim() === "true"
  );
}

function assertStoppedCleanly(container, expectedExitCode) {
  const state = JSON.parse(
    docker(["inspect", "--format", "{{json .State}}", container]),
  );
  assert.equal(state.Running, false);
  assert.equal(state.Pid, 0, "container retained a running process");
  if (expectedExitCode === 0) {
    assert.equal(state.ExitCode, 0);
  } else {
    assert.notEqual(state.ExitCode, 0);
  }
}

function assertValidRecoveryMedia() {
  const streams = JSON.parse(
    docker([
      "run",
      "--rm",
      "--volume",
      `${outputDirectory}:/capture:ro`,
      "--entrypoint",
      "ffprobe",
      image,
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      "/capture/recovered.flv",
    ]),
  ).streams;
  assert.ok(streams.some((stream) => stream.codec_name === "h264"));
  assert.ok(streams.some((stream) => stream.codec_name === "aac"));
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
