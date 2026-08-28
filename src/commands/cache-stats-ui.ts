import * as vscode from "vscode";

import {
  CacheStatsTracker,
  formatCacheRate,
  formatTokens,
  type CacheStatsSnapshot,
} from "../core/cache-stats.js";

export interface CacheStatsUiServices {
  readonly output?: vscode.OutputChannel;
}

/**
 * Renders one status bar item per route with recorded usage, e.g.
 * `$(database) Codex·OAuth 84%` where the percentage is the prompt-cache hit
 * rate. Clicking shows a quick pick with per-route details and a reset action.
 */
export class CacheStatsStatusBar {
  private readonly items = new Map<CacheStatsTracker, vscode.StatusBarItem>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly trackers: readonly CacheStatsTracker[],
    services: CacheStatsUiServices = {},
  ) {
    for (const tracker of trackers) {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
      item.name = `Codex cache stats (${tracker.label})`;
      item.command = "copilotCodex.cacheStats.show";
      this.items.set(tracker, item);
      const unsubscribe = tracker.onDidChange(() => this.render());
      this.disposables.push(
        { dispose: unsubscribe },
        item,
      );
    }
    this.disposables.push(
      vscode.commands.registerCommand("copilotCodex.cacheStats.show", () => {
        void this.showDetails();
      }),
      vscode.commands.registerCommand("copilotCodex.cacheStats.reset", () => {
        for (const tracker of trackers) {
          tracker.reset();
        }
        services.output?.appendLine("[cache-stats] reset all route statistics");
      }),
    );
    this.render();
  }

  public render(): void {
    for (const [tracker, item] of this.items) {
      const snapshot = tracker.snapshot();
      if (snapshot.turns === 0) {
        item.hide();
        continue;
      }
      const rate = snapshot.cacheRate !== undefined
        ? formatCacheRate(snapshot.cacheRate)
        : "—";
      item.text = `$(database) Codex·${snapshot.label} ${rate}`;
      const contextLine = snapshot.lastInputTokens !== undefined
        ? `- Context (last turn): ${formatTokens(snapshot.lastInputTokens)} in`
          + `${snapshot.lastOutputTokens !== undefined
            ? ` + ${formatTokens(snapshot.lastOutputTokens)} out`
            : ""} tokens\n`
        : "";
      item.tooltip = new vscode.MarkdownString(
        `**Codex · ${snapshot.label}** (session)\n\n`
        + `- Cache hit rate: **${rate}**\n`
        + contextLine
        + `- Cached input: ${formatTokens(snapshot.cachedTokens)} tokens\n`
        + `- Total input: ${formatTokens(snapshot.inputTokens)} tokens\n`
        + `- Total output: ${formatTokens(snapshot.outputTokens)} tokens\n`
        + `- Turns: ${snapshot.turns}\n\n`
        + "_Click for details and reset._",
      );
      item.show();
    }
  }

  private async showDetails(): Promise<void> {
    const picks: Array<vscode.QuickPickItem & { readonly reset?: boolean }> = [];
    for (const tracker of this.trackers) {
      const s = tracker.snapshot();
      if (s.turns === 0) {
        picks.push({
          label: `$(circle-slash) Codex · ${s.label}`,
          description: "no usage recorded yet",
        });
        continue;
      }
      picks.push({
        label: `$(database) Codex · ${s.label}`,
        description: `cache ${formatCacheRate(s.cacheRate ?? 0)} · in ${formatTokens(s.inputTokens)} · out ${formatTokens(s.outputTokens)} · ${s.turns} turns`,
        detail: `cached ${formatTokens(s.cachedTokens)} of ${formatTokens(s.inputTokens)} input tokens served from the prompt cache`
          + (s.lastInputTokens !== undefined
            ? ` · context (last turn): ${formatTokens(s.lastInputTokens)} in`
              + (s.lastOutputTokens !== undefined ? ` + ${formatTokens(s.lastOutputTokens)} out` : "")
            : ""),
      });
    }
    picks.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    picks.push({ label: "$(trash) Reset statistics", reset: true });

    const selected = await vscode.window.showQuickPick(picks, {
      title: "Codex Cache Statistics",
      placeHolder: "Prompt cache hit rate for this VS Code session",
    });
    if (selected?.reset === true) {
      await vscode.commands.executeCommand("copilotCodex.cacheStats.reset");
    }
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.items.clear();
  }
}
