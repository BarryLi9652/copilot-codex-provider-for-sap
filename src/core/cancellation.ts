import type { CancellationToken } from "vscode";

export interface AbortSignalBinding {
  signal: AbortSignal;
  dispose(): void;
}

export function toAbortSignal(token: CancellationToken): AbortSignalBinding {
  const controller = new AbortController();
  let disposed = false;
  let subscription: { dispose(): void } | undefined;

  const abort = (): void => {
    if (!disposed && !controller.signal.aborted) {
      controller.abort();
    }
  };

  const dispose = (): void => {
    if (!disposed) {
      disposed = true;
      subscription?.dispose();
    }
  };

  if (token.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose };
  }

  subscription = token.onCancellationRequested(abort);
  if (token.isCancellationRequested) {
    abort();
  }

  return { signal: controller.signal, dispose };
}
