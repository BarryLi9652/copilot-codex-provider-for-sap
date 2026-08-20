import type { CodexModel } from "./types.js";

type ModelLoader = () => Promise<readonly CodexModel[]>;

export class ModelCache {
  private cached: { models: readonly CodexModel[]; expiresAt: number } | undefined;
  private inFlight: Promise<readonly CodexModel[]> | undefined;
  private generation = 0;

  public constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public get(load: ModelLoader): Promise<readonly CodexModel[]> {
    if (this.cached !== undefined && this.now() < this.cached.expiresAt) {
      return Promise.resolve(this.cached.models);
    }

    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const generation = this.generation;
    const refresh = Promise.resolve()
      .then(load)
      .then(
        (models) => {
          if (generation === this.generation) {
            this.cached = { models, expiresAt: this.now() + this.ttlMs };
            this.inFlight = undefined;
          }
          return models;
        },
        (error: unknown) => {
          if (generation === this.generation) {
            this.inFlight = undefined;
          }
          throw error;
        },
      );

    this.inFlight = refresh;
    return refresh;
  }

  public clear(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
  }
}
