import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogger, publicUrl } from "../src/logger.ts";

test("structured logs redact stream keys and URL credentials", () => {
  const sourceUrl = new URL(
    "https://user:password@example.com/player?token=source-secret#fragment",
  );
  const rtmpUrl = new URL("rtmps://ingest.example.com/live/stream-secret");
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    secrets: [sourceUrl.href, rtmpUrl.href],
    write: (line) => lines.push(line),
  });

  logger.info("stream_starting", {
    source: publicUrl(sourceUrl),
    diagnostic: `publishing ${rtmpUrl.href}`,
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /password|source-secret|stream-secret/);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  delete entry.timestamp;
  assert.deepEqual(entry, {
    level: "info",
    event: "stream_starting",
    source: "https://example.com/player",
    diagnostic: "publishing [REDACTED]",
  });
});
