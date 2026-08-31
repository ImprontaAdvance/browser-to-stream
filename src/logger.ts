import type { LogLevel } from "./config.js";

export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = Readonly<{
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
}>;

type LoggerOptions = Readonly<{
  level: LogLevel;
  secrets?: readonly string[];
  write?: (line: string, level: LogLevel) => void;
}>;

const priorities: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger({
  level,
  secrets = [],
  write = defaultWriter,
}: LoggerOptions): Logger {
  const activeSecrets = [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);

  const log = (entryLevel: LogLevel, event: string, fields: LogFields = {}) => {
    if (priorities[entryLevel] < priorities[level]) {
      return;
    }

    const entry = sanitize(
      {
        timestamp: new Date().toISOString(),
        level: entryLevel,
        event,
        ...fields,
      },
      activeSecrets,
    );
    write(JSON.stringify(entry), entryLevel);
  };

  return Object.freeze({
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  });
}

export function publicUrl(url: URL): string {
  const safe = new URL(url);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.href.replace(/\/$/, url.pathname === "/" ? "/" : "");
}

function defaultWriter(line: string, level: LogLevel): void {
  const destination =
    level === "warn" || level === "error" ? process.stderr : process.stdout;
  destination.write(`${line}\n`);
}

function sanitize(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (result, secret) => result.split(secret).join("[REDACTED]"),
      value,
    );
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message, secrets),
      stack: sanitize(value.stack, secrets),
    };
  }
  if (value instanceof URL) {
    return "[REDACTED_URL]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitize(item, secrets),
      ]),
    );
  }
  return value;
}
