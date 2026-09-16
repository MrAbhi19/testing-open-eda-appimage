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
