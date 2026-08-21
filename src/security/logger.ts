import { redactMetadata } from "./redact.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogSink {
  appendLine(value: string): void;
}

export class SafeLogger {
  public constructor(
    private readonly sink: LogSink,
    private readonly level: () => LogLevel,
  ) {}

  public event(
    name: string,
    metadata: Record<string, unknown> = {},
    eventLevel: LogLevel = "info",
  ): void {
    if (LOG_LEVEL_ORDER[eventLevel] > LOG_LEVEL_ORDER[this.level()]) {
      return;
    }
    const redacted = redactMetadata(metadata) as Record<string, unknown>;
    this.sink.appendLine(
      JSON.stringify({
        ...redacted,
        time: new Date().toISOString(),
        event: name,
      }),
    );
  }
}

const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
