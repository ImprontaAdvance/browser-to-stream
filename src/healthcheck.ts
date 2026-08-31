const rawPort = process.env.HEALTH_PORT?.trim() || "3000";
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write("HEALTH_PORT is invalid\n");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/livez`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`health endpoint returned ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`healthcheck failed: ${message}\n`);
    process.exitCode = 1;
  }
}
