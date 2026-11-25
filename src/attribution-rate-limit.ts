export class AttributionRateLimit {
  private readonly clients = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly maxRequests = 60,
    private readonly windowMs = 60_000,
    private readonly maxClients = 10_000,
  ) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 60
        || !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 60_000
        || !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 10_000) {
      throw new Error('Invalid attribution rate limit.');
    }
  }

  allow(client: string, now: number): boolean {
    let entry = this.clients.get(client);
    if (entry && entry.expiresAt <= now) {
      this.clients.delete(client);
      entry = undefined;
    }
    if (!entry) {
      if (this.clients.size >= this.maxClients) {
        for (const [key, value] of this.clients) if (value.expiresAt <= now) this.clients.delete(key);
        if (this.clients.size >= this.maxClients) return false;
      }
      this.clients.set(client, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.maxRequests) return false;
    entry.count += 1;
    return true;
  }
}
