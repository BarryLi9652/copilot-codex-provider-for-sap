import { CodexError } from "./errors.js";
import type {
  CodexModel,
  CodexRequest,
  CodexTransport,
  TransportEvent,
} from "./types.js";

export class EmptyTransport implements CodexTransport {
  public constructor(private readonly error: CodexError) {}

  public listModels(
    _options: { silent: boolean; forceRefresh?: boolean },
    _signal: AbortSignal,
  ): Promise<readonly CodexModel[]> {
    return Promise.resolve([]);
  }

  public generate(_request: CodexRequest, _signal: AbortSignal): AsyncIterable<TransportEvent> {
    throw this.error;
  }

  public async dispose(): Promise<void> {}
}
