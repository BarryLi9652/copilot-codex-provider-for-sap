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

  public event(name: string, metadata: Record<string, unknown> = {}): void {
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
