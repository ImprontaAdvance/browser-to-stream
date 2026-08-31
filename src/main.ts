import { loadConfig } from "./config.js";
import { startHealthServer } from "./health-server.js";
import { createLogger } from "./logger.js";
import { RealSessionRuntime } from "./runtime.js";
import { StreamingSession } from "./streaming-session.js";

async function main(): Promise<void> {
  const bootstrapLogger = createLogger({ level: "info" });
  let config;
  try {
    config = await loadConfig(process.env);
  } catch (error) {
    bootstrapLogger.error("configuration_invalid", { error });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({
    level: config.logLevel,
    secrets: [config.sourceUrl.href, config.rtmpUrl.href],
  });
  const runtime = new RealSessionRuntime(logger);
  const session = new StreamingSession(config, runtime, logger);

  let healthServer;
  try {
    healthServer = await startHealthServer({
      port: config.healthPort,
      snapshot: () => session.snapshot(),
      logger,
    });
  } catch (error) {
    logger.error("health_server_failed", { error });
    process.exitCode = 1;
    return;
  }

  let shutdownStarted = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownStarted) {
      logger.warn("shutdown_already_in_progress", { signal });
      return;
    }
    shutdownStarted = true;
    logger.info("shutdown_requested", { signal });
    void session.stop().catch((error) => {
      logger.error("shutdown_failed", { error });
      process.exitCode = 1;
    });
  };
  const onSigterm = () => handleSignal("SIGTERM");
  const onSigint = () => handleSignal("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  try {
    await session.start();
  } catch (error) {
    logger.error("application_failed", { error });
    process.exitCode = 1;
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    try {
      await healthServer.stop();
    } catch (error) {
      logger.warn("health_server_stop_failed", { error });
      process.exitCode = 1;
    }
  }
}

await main();
