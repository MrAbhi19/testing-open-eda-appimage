export interface RateLimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface RateLimitState {
  requestTokens: number;
  tokenTokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private config: RateLimitConfig;
  private state: RateLimitState;
  private readonly refillIntervalMs = 60000;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.state = {
      requestTokens: config.requestsPerMinute,
      tokenTokens: config.tokensPerMinute,
      lastRefill: Date.now(),
    };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const intervals = Math.floor(elapsed / this.refillIntervalMs);
      this.state.requestTokens = Math.min(
        this.config.requestsPerMinute,
        this.state.requestTokens + intervals * this.config.requestsPerMinute
      );
      this.state.tokenTokens = Math.min(
        this.config.tokensPerMinute,
        this.state.tokenTokens + intervals * this.config.tokensPerMinute
      );
      this.state.lastRefill = now;
    }
  }

  async acquire(requestTokens: number = 1, tokenTokens: number = 0): Promise<void> {
    // Clamp to bucket capacity so we can never wait on an impossible request.
    requestTokens = Math.min(requestTokens, this.config.requestsPerMinute);
    tokenTokens = Math.min(tokenTokens, this.config.tokensPerMinute);

    while (true) {
      this.refill();

      if (
        this.state.requestTokens >= requestTokens &&
        this.state.tokenTokens >= tokenTokens
      ) {
        this.state.requestTokens -= requestTokens;
        this.state.tokenTokens -= tokenTokens;
        return;
      }

      const waitTime =
        this.refillIntervalMs - (Date.now() - this.state.lastRefill);
      await new Promise((r) => setTimeout(r, Math.max(waitTime, 100)));
    }
  }

  getAvailableRequests(): number {
    this.refill();
    return this.state.requestTokens;
  }

  getAvailableTokens(): number {
    this.refill();
    return this.state.tokenTokens;
  }

  reset(): void {
    this.state = {
      requestTokens: this.config.requestsPerMinute,
      tokenTokens: this.config.tokensPerMinute,
      lastRefill: Date.now(),
    };
  }
}

export function createRateLimiter(config: RateLimitConfig): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter(config);
}
