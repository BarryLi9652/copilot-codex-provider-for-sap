export interface UsageRecord {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly contextInputTokens?: number;
  readonly contextOutputTokens?: number;
}

export interface CacheStatsSnapshot {
  readonly label: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  /**
   * Fraction of input tokens served from the prompt cache, 0..1.
   * Undefined when no usage has been recorded yet.
   */
  readonly cacheRate: number | undefined;
  /**
   * Input tokens of the most recent usage event. Transports report per-turn
   * totals for input (the full prompt of that turn), so this approximates the
   * session's current context size. Undefined until an event carries input.
   */
  readonly lastInputTokens: number | undefined;
  /**
   * Output tokens of the most recent usage event. Undefined until an event
   * carries output.
   */
  readonly lastOutputTokens: number | undefined;
}
type ChangeListener = () => void;

/**
 * Aggregates token usage per route so the cache hit rate can be surfaced in
 * the status bar. Both transports emit delta-based usage events, so simply
 * summing them yields session totals. Framework-free (no vscode import) so
 * it stays unit-testable under plain node.
 */
export class CacheStatsTracker {
  private readonly listeners = new Set<ChangeListener>();
  private inputTokens = 0;
  private cachedTokens = 0;
  private outputTokens = 0;
  private turns = 0;
  private lastInputTokens: number | undefined;
  private lastOutputTokens: number | undefined;

  public constructor(public readonly label: string) {}

  public onDidChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public record(usage: UsageRecord): void {
    if (usage.inputTokens === undefined
      && usage.cachedTokens === undefined
      && usage.outputTokens === undefined) {
      return;
    }
    this.inputTokens += usage.inputTokens ?? 0;
    this.cachedTokens += usage.cachedTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.turns += 1;
    // Local CLI uses delta-based input/output for aggregation but also supplies
    // full thread totals for the context display. Other transports use their
    // input/output usage values directly as full current-turn totals.
    if (usage.contextInputTokens !== undefined || usage.inputTokens !== undefined) {
      this.lastInputTokens = usage.contextInputTokens ?? usage.inputTokens;
    }
    if (usage.contextOutputTokens !== undefined || usage.outputTokens !== undefined) {
      this.lastOutputTokens = usage.contextOutputTokens ?? usage.outputTokens;
    }
    this.notifyChanged();
  }

  public snapshot(): CacheStatsSnapshot {
    return {
      label: this.label,
      turns: this.turns,
      inputTokens: this.inputTokens,
      cachedTokens: this.cachedTokens,
      outputTokens: this.outputTokens,
      cacheRate: this.inputTokens > 0
        ? Math.min(1, this.cachedTokens / this.inputTokens)
        : undefined,
      lastInputTokens: this.lastInputTokens,
      lastOutputTokens: this.lastOutputTokens,
    };
  }

  public reset(): void {
    this.inputTokens = 0;
    this.cachedTokens = 0;
    this.outputTokens = 0;
    this.turns = 0;
    this.lastInputTokens = undefined;
    this.lastOutputTokens = undefined;
    this.notifyChanged();
  }

  public dispose(): void {
    this.listeners.clear();
  }

  private notifyChanged(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(2)}M`
    : tokens >= 1_000
      ? `${(tokens / 1_000).toFixed(1)}k`
      : `${tokens}`;

export const formatCacheRate = (rate: number): string => `${Math.round(rate * 100)}%`;
