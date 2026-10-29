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

  // Only declare JSON when there is a body: Discord rejects an empty body sent as
  // application/json with 50109 "invalid JSON" (this broke every unban)
  const headers: Record<string, string> = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    ...(options.body !== undefined && options.body !== null ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  // Header values must be ASCII: Discord expects the audit log reason URI-encoded (max 512 chars)
  const reason = headers['X-Audit-Log-Reason'];
  if (reason !== undefined) {
    headers['X-Audit-Log-Reason'] = encodeURIComponent(reason.slice(0, 512));
  }

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

// Longest 429 wait handled inside one request; longer ones are returned to the caller
const MAX_INLINE_RETRY_WAIT_MS = 15_000;

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
      // Bucket exhausted: wait for the reset now instead of running into a 429 next time.
      // Waiting costs no subrequests, a 429 retry costs one.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetAfter = parseFloat(res.headers.get('x-ratelimit-reset-after') || '');
        if (!isNaN(resetAfter) && resetAfter > 0) {
          await sleep(Math.min(Math.ceil(resetAfter * 1000), 10_000));
        }
      }
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

    // Long waits would block the whole invocation; hand the 429 back so a BanJob can
    // reschedule the item for a later alarm run instead
    if (waitMs > MAX_INLINE_RETRY_WAIT_MS) {
      console.warn(`Rate limited (429) on ${endpoint}, retry after ${waitMs}ms is too long to wait inline`);
      return res;
    }

    console.warn(`Rate limited (429) on ${endpoint}, waiting ${waitMs}ms before retry ${attempt}/${maxRetries}`);
    await sleep(waitMs);
  }
}

export type BanStatus = 'banned' | 'guild_gone' | 'missing_permissions' | 'rate_limited' | 'error';

/**
 * Ban a single user. Only needs BAN_MEMBERS, so it is the fallback for servers where the bot
 * lacks MANAGE_GUILD for the bulk ban endpoint. Banning an already banned user also succeeds.
 */
export async function banUser(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string,
  deleteMessageSeconds?: number
): Promise<{ status: BanStatus; error?: string; retryAfterMs?: number }> {
  const body: any = {};
  if (deleteMessageSeconds) {
    body.delete_message_seconds = Math.min(deleteMessageSeconds, 604800);
  }

  const response = await discordRequestWithRetry(
    env,
    `/guilds/${guildId}/bans/${userId}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    },
    2
  );

  if (response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return { status: 'banned' };
  }

  const err = await readDiscordError(response);
  if (isGuildGoneError(err)) return { status: 'guild_gone' };
  if (err.code === DiscordErrorCode.MISSING_PERMISSIONS) return { status: 'missing_permissions', error: describeDiscordError(err) };
  if (err.status === 429) return { status: 'rate_limited', error: describeDiscordError(err), retryAfterMs: err.retryAfterMs };
  return { status: 'error', error: describeDiscordError(err) };
}

export type UnbanStatus = 'unbanned' | 'not_banned' | 'guild_gone' | 'rate_limited' | 'error';

/**
 * Unban a user from a guild
 */
export async function unbanUser(
  env: Env,
  guildId: string,
  userId: string,
  reason?: string
): Promise<{ status: UnbanStatus; error?: string; retryAfterMs?: number }> {
  const response = await discordRequestWithRetry(
    env,
    `/guilds/${guildId}/bans/${userId}`,
    {
      method: 'DELETE',
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    },
    2
  );

  if (response.ok) {
    // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
    await response.text().catch(() => {});
    return { status: 'unbanned' };
  }

  const err = await readDiscordError(response);
  if (err.code === DiscordErrorCode.UNKNOWN_BAN) return { status: 'not_banned' };
  if (isGuildGoneError(err)) return { status: 'guild_gone' };
  if (err.status === 429) return { status: 'rate_limited', error: describeDiscordError(err), retryAfterMs: err.retryAfterMs };
  return { status: 'error', error: describeDiscordError(err) };
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

/**
 * Discord JSON error codes the bot reacts to
 */
export const DiscordErrorCode = {
  UNKNOWN_GUILD: 10004,
  UNKNOWN_BAN: 10026,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
  FAILED_TO_BAN_USERS: 500000,
} as const;

export interface DiscordApiError {
  status: number;
  code?: number;
  message?: string;
  /** 429 only: how long Discord asks us to wait */
  retryAfterMs?: number;
  /** 429 only: user, global or shared; missing when Cloudflare (not Discord) limited the request */
  scope?: string;
}

/**
 * Read (and consume) the body of a failed Discord response
 */
export async function readDiscordError(response: Response): Promise<DiscordApiError> {
  const text = await response.text().catch(() => '');
  const err: DiscordApiError = { status: response.status };

  if (response.status === 429) {
    const retryAfter = parseFloat(response.headers.get('retry-after') || '');
    if (!isNaN(retryAfter)) err.retryAfterMs = Math.ceil(retryAfter * 1000);
    err.scope = response.headers.get('x-ratelimit-global') === 'true'
      ? 'global'
      : response.headers.get('x-ratelimit-scope') || undefined;
  }

  try {
    const body: any = JSON.parse(text);
    return { ...err, code: body?.code, message: body?.message };
  } catch {
    return { ...err, message: text.slice(0, 200) || undefined };
  }
}

/**
 * The bot was removed from the guild (or the guild was deleted).
 * Missing Permissions (50013) is deliberately NOT treated as gone: the bot is still there.
 */
export function isGuildGoneError(err: DiscordApiError): boolean {
  return err.code === DiscordErrorCode.UNKNOWN_GUILD || err.code === DiscordErrorCode.MISSING_ACCESS;
}

export function describeDiscordError(err: DiscordApiError): string {
  if (err.code === DiscordErrorCode.MISSING_PERMISSIONS) {
    // Bulk bans fall back to single bans without Manage Server, so this means Ban Members is missing
    return 'Missing permissions (bot needs Ban Members)';
  }
  if (err.status === 429) {
    const wait = err.retryAfterMs !== undefined ? `retry after ${Math.ceil(err.retryAfterMs / 1000)}s` : 'no retry time';
    return `Rate limited by Discord (${wait}, scope ${err.scope || 'unknown'})`;
  }
  return `HTTP ${err.status}${err.code ? ` (code ${err.code})` : ''}${err.message ? `: ${err.message}` : ''}`;
}

/**
 * Error thrown by the runtime when an invocation exceeds its subrequest budget
 */
export function isSubrequestLimitError(error: unknown): boolean {
  return String((error as any)?.message || error).includes('Too many subrequests');
}

export const BULK_BAN_MAX_USERS = 200;

export interface BulkBanResult {
  banned: string[];
  failed: string[];
  guildGone: boolean;
  /** The bot lacks MANAGE_GUILD (or BAN_MEMBERS): fall back to single bans */
  missingPermissions: boolean;
  /** Still rate limited after the inline retries: nobody was banned, try again later */
  rateLimited?: { retryAfterMs?: number };
  error?: string;
}

/**
 * Ban up to 200 users in a guild with a single request (POST /guilds/{id}/bulk-ban).
 * Requires the bot to have both BAN_MEMBERS and MANAGE_GUILD; without them the result says
 * `missingPermissions` and the caller falls back to banUser.
 * Users that are already banned or cannot be banned end up in `failed`.
 */
export async function bulkBanUsers(
  env: Env,
  guildId: string,
  userIds: string[],
  reason?: string,
  deleteMessageSeconds?: number
): Promise<BulkBanResult> {
  if (userIds.length > BULK_BAN_MAX_USERS) {
    throw new Error(`bulkBanUsers accepts at most ${BULK_BAN_MAX_USERS} users per call`);
  }

  const body: any = { user_ids: userIds };
  if (deleteMessageSeconds) {
    body.delete_message_seconds = Math.min(deleteMessageSeconds, 604800);
  }

  const response = await discordRequestWithRetry(
    env,
    `/guilds/${guildId}/bulk-ban`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
    },
    2
  );

  if (response.ok) {
    const data: any = await response.json().catch(() => ({}));
    return {
      banned: data.banned_users || [],
      failed: data.failed_users || [],
      guildGone: false,
      missingPermissions: false,
    };
  }

  const err = await readDiscordError(response);
  const base = { banned: [], failed: [...userIds], guildGone: false, missingPermissions: false };

  // Discord answers 500000 when none of the users could be banned (e.g. all already banned)
  if (err.code === DiscordErrorCode.FAILED_TO_BAN_USERS) {
    return base;
  }

  if (isGuildGoneError(err)) {
    return { ...base, guildGone: true };
  }

  if (err.code === DiscordErrorCode.MISSING_PERMISSIONS) {
    return { ...base, missingPermissions: true };
  }

  if (err.status === 429) {
    return { ...base, rateLimited: { retryAfterMs: err.retryAfterMs }, error: describeDiscordError(err) };
  }

  return { ...base, error: describeDiscordError(err) };
}

export interface GuildBanPage {
  ids: string[];
  /** Pass as `after` to fetch the next page */
  lastId?: string;
  /** true when this was the last page */
  done: boolean;
  guildGone: boolean;
  error?: string;
}

/**
 * Fetch one page (up to 1000) of a guild's banned user IDs.
 * Reading the ban list costs one request per 1000 bans instead of one per user and guild.
 */
export async function fetchGuildBanPage(env: Env, guildId: string, after?: string): Promise<GuildBanPage> {
  // An explicit `after` (0 for the first page) makes Discord sort ascending by user ID
  const response = await discordRequestWithRetry(env, `/guilds/${guildId}/bans?limit=1000&after=${after || '0'}`, {}, 2);

  if (!response.ok) {
    const err = await readDiscordError(response);
    const gone = isGuildGoneError(err);
    return { ids: [], done: true, guildGone: gone, error: gone ? undefined : describeDiscordError(err) };
  }

  const page = (await response.json()) as Array<{ user: { id: string } }>;
  const ids = page.map(ban => ban.user.id);

  return { ids, lastId: ids[ids.length - 1], done: ids.length < 1000, guildGone: false };
}

/**
 * List the guilds the bot is a member of (up to 200 per request, so one request for most bots)
 */
export async function getCurrentUserGuilds(env: Env): Promise<Array<{ id: string; name: string }> | null> {
  const guilds: Array<{ id: string; name: string }> = [];
  let after = '0';
  // Leave room for response messages within the Free plan's external subrequest budget.
  for (let page = 0; page < 40; page++) {
    const response = await discordRequest(env, `/users/@me/guilds?limit=200&after=${after}`);
    if (!response.ok) {
      await response.text().catch(() => {});
      return null;
    }
    const batch = await response.json() as Array<{ id: string; name: string }>;
    guilds.push(...batch);
    if (batch.length < 200) return guilds;
    const lastId = batch[batch.length - 1].id;
    if (lastId === after) return null;
    after = lastId;
  }
  // Never present a partial list as a complete audit.
  return null;
}

/**
 * Edit the original interaction response (the deferred reply or the message with the button).
 * Uses the interaction token, which stays valid for 15 minutes.
 */
export async function editOriginalResponse(
  applicationId: string,
  token: string,
  content: { content?: string; embeds?: DiscordEmbed[]; components?: any[] }
): Promise<boolean> {
  const response = await fetch(`${DISCORD_API_BASE}/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  });

  // IMPORTANT: Always consume response body to prevent Cloudflare Workers deadlock
  const ok = response.ok;
  await response.text().catch(() => {});
  return ok;
}
