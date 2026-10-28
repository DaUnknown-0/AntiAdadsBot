import { Env } from '../types/env';
import { DiscordEmbed } from '../types/discord';

/**
 * Discord API utility functions
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Send a follow-up message to a deferred interaction
 * Uses the interaction token (valid for 15 minutes after initial response)
 */
export async function sendFollowupMessage(
  applicationId: string,
  token: string,
  content: { content?: string; embeds?: DiscordEmbed[]; components?: any[]; flags?: number }
): Promise<Response> {
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${token}`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(content),
  });
}

/**
 * Make a Discord API request
 */
async function discordRequest(
  env: Env,
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${DISCORD_API_BASE}${endpoint}`;

  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Get guild information
 */
export async function getGuild(env: Env, guildId: string): Promise<any> {
  const response = await discordRequest(env, `/guilds/${guildId}`);

  if (!response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return null;
  }

  return response.json();
}

/**
 * Get guild member information
 */
export async function getGuildMember(
  env: Env,
  guildId: string,
  userId: string
): Promise<any> {
  const response = await discordRequest(env, `/guilds/${guildId}/members/${userId}`);

  if (!response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return null;
  }

  return response.json();
}

/**
 * Ban a user from a guild
 */
// Simple sleep helper
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async mapper over items with a bounded number of concurrent workers.
 * Results are returned in the same order as the input items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Discord request with automatic handling of 429 rate limits.
 * Retries up to `maxRetries` times, waiting the server-specified retry-after if provided.
 * Discord's ban endpoint typically allows 5 requests per 5 seconds per guild.
 */
export async function discordRequestWithRetry(
  env: Env,
  endpoint: string,
  options: RequestInit = {},
  maxRetries = 5
): Promise<Response> {
  let attempt = 0;

  while (true) {
    const res = await discordRequest(env, endpoint, options);

    if (res.status !== 429) {
      // Not rate limited - return response (caller must consume body)
      return res;
    }

    // Rate limited - we need to consume this response body before retrying
    const bodyText = await res.text().catch(() => '{}');

    // Handle 429
    attempt++;
    if (attempt > maxRetries) {
      console.error(`Gave up after ${maxRetries} retries due to rate limiting`);
      return res; // give up
    }

    // Try to parse Retry-After header (seconds) or JSON body retry_after
    let waitMs = 5000 * attempt; // exponential backoff: 5s, 10s, 15s...

    const header = res.headers.get('retry-after');
    if (header) {
      const parsed = parseFloat(header);
      if (!isNaN(parsed)) {
        // Discord's Retry-After header is in seconds
        waitMs = Math.ceil(parsed * 1000);
      }
    } else {
      try {
        const body: any = JSON.parse(bodyText);
        if (body && body.retry_after !== undefined) {
          const rv = Number(body.retry_after);
          if (!isNaN(rv)) {
            // retry_after in response body is typically in seconds
            waitMs = Math.ceil(rv * 1000);
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    console.warn(`Rate limited (429), waiting ${waitMs}ms before retry ${attempt}/${maxRetries}`);
    await sleep(waitMs);
  }
}

export async function banUser(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string,
  deleteMessageSeconds?: number
): Promise<boolean> {
  const body: any = {};
  if (deleteMessageSeconds) {
    body.delete_message_seconds = deleteMessageSeconds;
  }

  const response = await discordRequestWithRetry(
    env,
    `/guilds/${guildId}/bans/${userId}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Unban a user from a guild
 */
export async function unbanUser(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/bans/${userId}`,
    {
      method: 'DELETE',
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Check if a user is banned in a guild
 */
export async function isUserBanned(env: Env, guildId: string, userId: string): Promise<boolean> {
  try {
    const response = await discordRequest(env, `/guilds/${guildId}/bans/${userId}`);
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    const isOk = response.ok;
    await response.text().catch(() => {});
    return isOk;
  } catch (err) {
    console.error('Error checking ban status:', err);
    return false;
  }
}

/**
 * Kick a user from a guild
 */
export async function kickUser(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: 'DELETE',
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Timeout a user (communication disable)
 */
export async function timeoutUser(
  env: Env,
  guildId: string,
  userId: string,
  until: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        communication_disabled_until: until,
      }),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Remove timeout from a user
 */
export async function removeTimeout(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        communication_disabled_until: null,
      }),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Bulk delete messages
 */
export async function bulkDeleteMessages(
  env: Env,
  channelId: string,
  messageIds: string[],
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/channels/${channelId}/messages/bulk-delete`,
    {
      method: 'POST',
      body: JSON.stringify({ messages: messageIds }),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Get channel messages
 */
export async function getChannelMessages(
  env: Env,
  channelId: string,
  limit: number = 100
): Promise<any[]> {
  const response = await discordRequest(
    env,
    `/channels/${channelId}/messages?limit=${limit}`
  );

  if (!response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return [];
  }

  return response.json();
}

/**
 * Send a message to a channel
 */
export async function sendMessage(
  env: Env,
  channelId: string,
  content?: string,
  embeds?: DiscordEmbed[]
): Promise<any> {
  const body: any = {};
  if (content) body.content = content;
  if (embeds) body.embeds = embeds;

  const response = await discordRequest(
    env,
    `/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return null;
  }

  return response.json();
}

/**
 * Set channel slowmode
 */
export async function setSlowmode(
  env: Env,
  channelId: string,
  seconds: number,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/channels/${channelId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ rate_limit_per_user: seconds }),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Update channel permissions (for lockdown)
 */
export async function updateChannelPermissions(
  env: Env,
  channelId: string,
  overwriteId: string,
  allow: string,
  deny: string,
  type: number,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/channels/${channelId}/permissions/${overwriteId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ allow, deny, type }),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Add role to member
 */
export async function addRoleToMember(
  env: Env,
  guildId: string,
  userId: string,
  roleId: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'PUT',
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Remove role from member
 */
export async function removeRoleFromMember(
  env: Env,
  guildId: string,
  userId: string,
  roleId: string,
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'DELETE',
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Modify guild member (nickname, etc.)
 */
export async function modifyGuildMember(
  env: Env,
  guildId: string,
  userId: string,
  data: { nick?: string | null },
  reason?: string
): Promise<boolean> {
  const response = await discordRequest(
    env,
    `/guilds/${guildId}/members/${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    }
  );

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}

/**
 * Convert a Discord snowflake ID to a timestamp in milliseconds
 */
export function snowflakeTimestamp(id: string): number {
  const DISCORD_EPOCH = 1420070400000n;
  try {
    const ts = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    return Number(ts);
  } catch (err) {
    throw new Error('Invalid snowflake ID');
  }
}
