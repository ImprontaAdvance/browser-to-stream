import { createServer, type ServerResponse } from "node:http";

import type { Logger } from "./logger.js";
import type { SessionSnapshot } from "./streaming-session.js";

type HealthServerOptions = Readonly<{
  port: number;
  snapshot: () => SessionSnapshot;
  logger: Logger;
}>;

export type HealthServer = Readonly<{
  port: number;
  stop: () => Promise<void>;
}>;

export async function startHealthServer({
  port,
  snapshot,
  logger,
}: HealthServerOptions): Promise<HealthServer> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");

    if (request.method !== "GET") {
      send(response, 405, { error: "method-not-allowed" });
      return;
    }

    if (request.url === "/livez") {
      send(response, 200, { status: "live" });
      return;
    }

    const current = snapshot();
    if (request.url === "/readyz") {
      send(
        response,
        current.ready ? 200 : 503,
        current.ready
          ? { status: "ready", state: current.state }
          : { status: "not-ready", state: current.state },
      );
      return;
    }

    if (request.url === "/status") {
      send(response, 200, current);
      return;
    }

    send(response, 404, { error: "not-found" });
  });

  server.on("clientError", (error, socket) => {
    logger.warn("health_client_error", { error });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Health server did not bind to a TCP port");
  }

  logger.info("health_server_listening", { port: address.port });
  return Object.freeze({
    port: address.port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  });
}

function send(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}
