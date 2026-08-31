import assert from "node:assert/strict";
import { test } from "node:test";

import { startHealthServer } from "../src/health-server.ts";
import type { Logger } from "../src/logger.ts";
import type { SessionSnapshot } from "../src/streaming-session.ts";

test("reports liveness separately from streaming readiness", async () => {
  let snapshot: SessionSnapshot = {
    state: "starting",
    ready: false,
    uptimeSeconds: 2,
    reconnectCount: 0,
    lastProgressAt: null,
  };
  const server = await startHealthServer({
    port: 0,
    snapshot: () => snapshot,
    logger: silentLogger,
  });

  try {
    const live = await fetch(`http://127.0.0.1:${server.port}/livez`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "live" });

    const notReady = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    assert.equal(notReady.status, 503);
    assert.deepEqual(await notReady.json(), {
      status: "not-ready",
      state: "starting",
    });

    snapshot = {
      state: "streaming",
      ready: true,
      uptimeSeconds: 5,
      reconnectCount: 1,
      lastProgressAt: "2026-08-28T10:00:00.000Z",
    };
    const ready = await fetch(`http://127.0.0.1:${server.port}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: "ready",
      state: "streaming",
    });

    const status = await fetch(`http://127.0.0.1:${server.port}/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), snapshot);
  } finally {
    await server.stop();
  }
});

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
