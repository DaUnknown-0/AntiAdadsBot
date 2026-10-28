import type { BanJob } from '../durable-objects/BanJob';

// Environment bindings for Cloudflare Workers
export interface Env {
  // Discord credentials
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;

  // Cloudflare bindings
  DB: D1Database;
  CACHE: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  BAN_JOBS: DurableObjectNamespace<BanJob>;

  // Optional runtime feature flags
  DISABLE_GLOBAL_BAN_WORKER?: string;

  // Admin/readonly keys for the global bans API
  GLOBAL_BANS_ADMIN_KEY?: string;
  GLOBAL_BANS_READONLY_KEY?: string;

  // Comma-separated list of special user IDs allowed to use global commands
  SPECIAL_USER_IDS?: string;
}
