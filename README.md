# browser-to-stream

Internal container application that renders one trusted web page and publishes its complete 1280×720 viewport, including browser audio, to one RTMP or RTMPS destination.

It is not a reusable Node.js package. One container owns one stream for its entire lifetime.

## Architecture

```text
StreamingSession
  ├─ Xvfb :99 (1280×720×24)
  ├─ PulseAudio null sink (browser.monitor)
  ├─ Chrome for Testing, controlled by Puppeteer
  └─ FFmpeg x11grab + pulse → H.264/AAC → FLV → RTMP(S)
```

The browser is captured as raw video and PCM audio. FFmpeg performs the only media encoding step; there is no Chrome extension, MediaRecorder, WebSocket, intermediate file, or in-memory media queue.

## Runtime configuration

| Variable               | Required     | Default | Meaning                                                                |
| ---------------------- | ------------ | ------- | ---------------------------------------------------------------------- |
| `SOURCE_URL`           | yes          | —       | Trusted `http://` or `https://` page to render.                        |
| `RTMP_URL_FILE`        | one of these | —       | Path to a file containing the RTMP/RTMPS URL. Preferred in production. |
| `RTMP_URL`             | one of these | —       | RTMP/RTMPS URL. Convenient locally but visible in Docker inspection.   |
| `VIDEO_BITRATE_KBPS`   | no           | `3000`  | Video bitrate, from 500 to 6000 kbps.                                  |
| `PAGE_LOAD_TIMEOUT_MS` | no           | `30000` | Timeout for each of three navigation attempts.                         |
| `PAGE_WARMUP_MS`       | no           | `5000`  | Delay between page readiness and publication.                          |
| `HEALTH_PORT`          | no           | `3000`  | Read-only health server port.                                          |
| `LOG_LEVEL`            | no           | `info`  | `debug`, `info`, `warn`, or `error`.                                   |

Exactly one of `RTMP_URL_FILE` and `RTMP_URL` must be set. RTMP destinations, query strings, URL credentials, and stream keys are redacted from application logs; source URLs are logged only in public form.

The media profile is deliberately fixed to 1280×720 at 30 fps, H.264 Main level 3.1, AAC-LC stereo at 48 kHz, and a two-second GOP.

## Build and run

The image targets `linux/amd64`, the production platform supported by the bundled Chrome for Testing build.

```bash
docker build --platform linux/amd64 -t browser-to-stream:1.0.0 .
```

Create the secret file so UID 1000 inside the container can read it:

```bash
sudo install -d -o root -g 1000 -m 0750 /opt/browser-to-stream
sudo install -o 1000 -g 1000 -m 0400 /dev/stdin /opt/browser-to-stream/rtmp-url
```

Paste the RTMP URL on stdin, then close it with <kbd>Ctrl</kbd>+<kbd>D</kbd>. This avoids putting the stream key in shell history.

Run one stream:

```bash
docker run --detach \
  --name browser-to-stream \
  --platform linux/amd64 \
  --restart unless-stopped \
  --cpus 2 \
  --memory 2g \
  --memory-swap 2g \
  --shm-size 1g \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount type=bind,src=/opt/browser-to-stream/rtmp-url,dst=/run/secrets/rtmp-url,readonly \
  --env SOURCE_URL=https://example.internal/player \
  --env RTMP_URL_FILE=/run/secrets/rtmp-url \
  --publish 127.0.0.1:3000:3000 \
  browser-to-stream:1.0.0
```

Do not add `--disable-dev-shm-usage`; the 1 GiB shared-memory allocation is intentional. Chrome runs as a non-root user with its sandbox disabled because this deployment profile only accepts trusted pages. Untrusted pages require a stronger isolation layer such as a dedicated VM, gVisor, or Kata Containers.

## Health and status

The server is read-only and does not start or stop streams:

- `GET /livez` returns `200` while the supervisor can answer requests.
- `GET /readyz` returns `200` only while FFmpeg output timestamps are advancing; startup and reconnection return `503`.
- `GET /status` returns the state, uptime, reconnection count, and last progress timestamp. It never returns either configured URL.

The image also contains a Docker `HEALTHCHECK`. Docker's `--restart` policy reacts to process exit, not to an unhealthy status, so fatal child failures and RTMP outages longer than 60 seconds intentionally terminate the Node process with a non-zero code.

## Recovery and shutdown

- FFmpeg stalls or RTMP disconnects trigger encoder-only retries after 1, 2, and then 5 seconds.
- The page and browser remain alive during transient output failures.
- An uninterrupted 60-second RTMP outage terminates the container so Docker performs a clean restart.
- Xvfb, PulseAudio, Chrome, or page crashes terminate the container immediately.
- `SIGTERM` and `SIGINT` stop FFmpeg, Chrome, PulseAudio, and Xvfb in that order, with a total ten-second grace budget.

JSON logs are written to stdout/stderr. A healthy session should alternate startup events with periodic FFmpeg progress consumed internally; progress itself is not logged at `info` level.

## Development

Node 24.20 and pnpm 11.21 are pinned by the project and container image.

```bash
PUPPETEER_SKIP_DOWNLOAD=true corepack pnpm install
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Run the container media smoke test after building `browser-to-stream:dev`:

```bash
docker build --platform linux/amd64 -t browser-to-stream:dev .
corepack pnpm test:e2e
```

The acceptance suite uses a local animated page and RTMP listener. It verifies H.264/AAC metadata, all four viewport edges, canvas animation, non-silent audio, transient recovery without restarting Chrome, the 60-second terminal outage, secret redaction, and graceful shutdown.

Run the same bounded-resource soak used by the scheduled workflow (two hours by default):

```bash
corepack pnpm test:soak
```

For a shorter diagnostic run, set `SOAK_DURATION_SECONDS`, `SOAK_SAMPLE_SECONDS`, and `SOAK_SEGMENT_SECONDS`. The soak keeps only three circular media segments and checks readiness, reconnects, Chrome restarts, memory growth, FFmpeg speed, and A/V drift.

## Troubleshooting

- **`configuration_invalid`**: verify the URL protocols and that exactly one RTMP setting is present.
- **`Virtual display failed to become ready`**: inspect Xvfb debug logs and confirm `/tmp` is writable.
- **`PulseAudio failed to become ready`**: confirm the container runs as its default user and has a writable `/tmp` tmpfs.
- **Viewport mismatch**: do not override Chrome flags or the fixed display dimensions.
- **Frequent `encoder_reconnecting` events**: check RTMP reachability, available upload bandwidth, and receiver bitrate limits.
- **FFmpeg speed below real time**: reserve two CPU cores per stream or reduce `VIDEO_BITRATE_KBPS`; this version intentionally does not use hardware encoding.
