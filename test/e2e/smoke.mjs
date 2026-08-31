import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const image = process.env.E2E_IMAGE ?? "browser-to-stream:dev";
const suffix = randomUUID().slice(0, 8);
const network = `browser-to-stream-e2e-${suffix}`;
const fixture = `browser-to-stream-fixture-${suffix}`;
const receiver = `browser-to-stream-receiver-${suffix}`;
const application = `browser-to-stream-app-${suffix}`;
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const applicationCodeMount = process.env.E2E_DIST_DIRECTORY
  ? ["--volume", `${resolve(process.env.E2E_DIST_DIRECTORY)}:/app/dist:ro`]
  : [];
const outputDirectory = await mkdtemp(join(tmpdir(), "browser-to-stream-e2e-"));
const keepArtifacts = process.env.E2E_KEEP_ARTIFACTS === "true";
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
    "warning",
    "-listen",
    "1",
    "-i",
    "rtmp://0.0.0.0:1935/live/test",
    "-c",
    "copy",
    "-y",
    "/capture/output.flv",
  ]);
  await delay(1_000);

  docker([
    "run",
    "--detach",
    "--name",
    application,
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
    `RTMP_URL=rtmp://${receiver}:1935/live/test`,
    "--env",
    "PAGE_WARMUP_MS=1000",
    image,
  ]);

  await waitForReady(application, 90_000);
  await delay(8_000);
  docker(["stop", "--time", "10", application]);
  await waitForStopped(receiver, 10_000);

  const probe = JSON.parse(
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
      "/capture/output.flv",
    ]),
  );
  assertMediaContract(probe);

  extractFrame(outputDirectory, image, 2, "frame-2.rgb");
  extractFrame(outputDirectory, image, 4, "frame-4.rgb");
  const frame2 = await readFile(join(outputDirectory, "frame-2.rgb"));
  const frame4 = await readFile(join(outputDirectory, "frame-4.rgb"));
  assertFrameContract(frame2, frame4);

  const volume = dockerResult([
    "run",
    "--rm",
    "--volume",
    `${outputDirectory}:/capture:ro`,
    "--entrypoint",
    "ffmpeg",
    image,
    "-hide_banner",
    "-i",
    "/capture/output.flv",
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]).stderr;
  const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume);
  assert.ok(meanVolume, "FFmpeg did not report an audio level");
  assert.ok(
    Number(meanVolume[1]) > -50,
    `audio is silent: ${meanVolume[1]} dB`,
  );

  process.stdout.write("container smoke test passed\n");
} catch (error) {
  dumpLogs(application);
  dumpLogs(receiver);
  throw error;
} finally {
  dockerResult(["rm", "--force", application], false);
  dockerResult(["rm", "--force", receiver], false);
  dockerResult(["rm", "--force", fixture], false);
  dockerResult(["network", "rm", network], false);
  if (keepArtifacts) {
    process.stderr.write(`E2E artifacts kept at ${outputDirectory}\n`);
  } else {
    await rm(outputDirectory, { recursive: true, force: true });
  }
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

async function waitForReady(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = dockerResult(
      [
        "exec",
        container,
        "node",
        "--input-type=module",
        "--eval",
        "const response=await fetch('http://127.0.0.1:3000/readyz'); if(!response.ok) process.exit(1)",
      ],
      false,
    );
    if (result.status === 0) {
      return;
    }
    const running = dockerResult(
      ["inspect", "--format", "{{.State.Running}}", container],
      false,
    ).stdout.trim();
    if (running === "false") {
      throw new Error("application container exited before becoming ready");
    }
    await delay(500);
  }
  throw new Error("application did not become ready within 90 seconds");
}

async function waitForStopped(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = dockerResult(
      ["inspect", "--format", "{{.State.Running}}", container],
      false,
    ).stdout.trim();
    if (running === "false") {
      return;
    }
    await delay(250);
  }
  docker(["stop", "--time", "3", container]);
}

function extractFrame(directory, imageName, second, output) {
  docker([
    "run",
    "--rm",
    "--volume",
    `${directory}:/capture`,
    "--entrypoint",
    "ffmpeg",
    imageName,
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(second),
    "-i",
    "/capture/output.flv",
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-y",
    `/capture/${output}`,
  ]);
}

function assertMediaContract(probe) {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.ok(video, "video stream is missing");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  const [numerator, denominator] = video.avg_frame_rate.split("/").map(Number);
  assert.ok(
    Math.abs(numerator / denominator - 30) < 0.1,
    "frame rate is not 30 fps",
  );
  assert.ok(audio, "audio stream is missing");
  assert.equal(audio.codec_name, "aac");
  assert.equal(audio.channels, 2);
  assert.equal(audio.sample_rate, "48000");
}

function assertFrameContract(frame2, frame4) {
  assert.equal(frame2.length, 1280 * 720 * 3);
  assert.equal(frame4.length, frame2.length);
  assertColor(frame2, 20, 20, [255, 0, 0], "top-left marker");
  assertColor(frame2, 1260, 20, [0, 255, 0], "top-right marker");
  assertColor(frame2, 20, 700, [0, 0, 255], "bottom-left marker");
  assertColor(frame2, 1260, 700, [255, 255, 0], "bottom-right marker");
  const center2 = pixel(frame2, 640, 500);
  const center4 = pixel(frame4, 640, 500);
  const difference = center2.reduce(
    (total, channel, index) => total + Math.abs(channel - center4[index]),
    0,
  );
  assert.ok(difference > 40, "canvas animation did not change between frames");
}

function assertColor(frame, x, y, expected, label) {
  const actual = pixel(frame, x, y);
  const distance = actual.reduce(
    (total, channel, index) => total + Math.abs(channel - expected[index]),
    0,
  );
  assert.ok(distance < 120, `${label} has unexpected RGB ${actual.join(",")}`);
}

function pixel(frame, x, y) {
  const offset = (y * 1280 + x) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
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
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
