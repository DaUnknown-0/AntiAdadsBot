import { DurableObject } from 'cloudflare:workers';

interface RateLimitEntry {
  timestamps: number[];
  blocked: boolean;
  blockedUntil?: number;
}

/**
 * RateLimiter Durable Object
 * Implements a sliding window rate limiter per user per guild
 * 
 * Limits:
 * - 5 commands per 10 seconds per user
 * - 30 commands per minute per user
 * - If exceeded, user is temporarily blocked for 30 seconds
 */
export class RateLimiter extends DurableObject {
  private limits = {
    shortWindow: 10000, // 10 seconds
    shortWindowMax: 5, // 5 commands per 10 seconds
    longWindow: 60000, // 1 minute
    longWindowMax: 30, // 30 commands per minute
    blockDuration: 30000, // 30 seconds block
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/check' && request.method === 'POST') {
      return this.checkRateLimit(request);
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      return this.resetRateLimit(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private async checkRateLimit(request: Request): Promise<Response> {
    const body = await request.json() as { guildId: string; userId: string; timestamp: number };
    const key = `${body.guildId}:${body.userId}`;
    const now = body.timestamp;
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now + 300000);

    // Get current rate limit data
    let entry: RateLimitEntry = await this.ctx.storage.get<RateLimitEntry>(key) || {
      timestamps: [],
      blocked: false,
    };

    // Check if user is currently blocked
    if (entry.blocked && entry.blockedUntil && now < entry.blockedUntil) {
      const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
      return new Response(
        JSON.stringify({
          allowed: false,
          retryAfter,
          reason: 'temporarily_blocked',
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Unblock if block period has passed
    if (entry.blocked && entry.blockedUntil && now >= entry.blockedUntil) {
      entry.blocked = false;
      entry.blockedUntil = undefined;
      entry.timestamps = [];
    }

    // Clean old timestamps outside both windows
    entry.timestamps = entry.timestamps.filter(
      (ts) => now - ts < this.limits.longWindow
    );

    // Count requests in short window (10 seconds)
    const shortWindowCount = entry.timestamps.filter(
      (ts) => now - ts < this.limits.shortWindow
    ).length;

    // Count requests in long window (1 minute)
    const longWindowCount = entry.timestamps.length;

    // Check if rate limit exceeded
    if (
      shortWindowCount >= this.limits.shortWindowMax ||
      longWindowCount >= this.limits.longWindowMax
    ) {
      // Block the user temporarily
      entry.blocked = true;
      entry.blockedUntil = now + this.limits.blockDuration;
      await this.ctx.storage.put(key, entry);

      return new Response(
        JSON.stringify({
          allowed: false,
          retryAfter: Math.ceil(this.limits.blockDuration / 1000),
          reason: 'rate_limit_exceeded',
          shortWindowCount,
          longWindowCount,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Add current timestamp
    entry.timestamps.push(now);
    await this.ctx.storage.put(key, entry);

    return new Response(
      JSON.stringify({
        allowed: true,
        shortWindowCount: shortWindowCount + 1,
        longWindowCount: longWindowCount + 1,
        shortWindowRemaining: this.limits.shortWindowMax - shortWindowCount - 1,
        longWindowRemaining: this.limits.longWindowMax - longWindowCount - 1,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async resetRateLimit(request: Request): Promise<Response> {
    const body = await request.json() as { guildId: string; userId: string };
    const key = `${body.guildId}:${body.userId}`;

    await this.ctx.storage.delete(key);

    return new Response(
      JSON.stringify({ success: true, message: 'Rate limit reset' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  async alarm(): Promise<void> {
    // Cleanup old entries periodically
    const now = Date.now();
    const allKeys = await this.ctx.storage.list();
    
    for (const [key, value] of allKeys.entries()) {
      const entry = value as RateLimitEntry;
      
      // Remove entries that haven't been used in 5 minutes
      const lastTimestamp = entry.timestamps[entry.timestamps.length - 1] || 0;
      if (now - lastTimestamp > 300000) {
        await this.ctx.storage.delete(key);
      }
    }

    if ((await this.ctx.storage.list({ limit: 1 })).size > 0) {
      await this.ctx.storage.setAlarm(now + 300000);
    }
  }
}
