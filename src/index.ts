import { verifyKey } from 'discord-interactions';
import { Env } from './types/env';
import { DiscordInteraction, InteractionType, InteractionResponseType } from './types/discord';
import { RateLimiter } from './durable-objects/RateLimiter';
import { BanJob, startBanJob } from './durable-objects/BanJob';
import { handleCommand } from './commands';
import { handleButtonInteraction } from './commands/moderation/handleButtonInteraction';
import { JsonResponse, ErrorResponse } from './utils/responses';
import { getInvokingUserId, isSpecialUser } from './utils/permissions';
import { addToGlobalBanListStatement, getGlobalBanList, getGuildsWithAutoEnforceEnabled } from './utils/databaseExtras';
import { MAX_JOB_USERS } from './utils/jobLimits';
import { readLimitedText } from './utils/input';

// Export Durable Object classes
export { RateLimiter, BanJob };

const GLOBAL_BAN_TASK_STATUSES = new Set(['pending', 'processing', 'completed', 'failed']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);

    // Handle scheduled check endpoint (can be triggered externally via cron-job.org)
    if (url.pathname === '/scheduled/check-global-bans' && request.method === 'POST') {
      return handleScheduledGlobalBanCheck(request, env, ctx);
    }

    // Helper auth checks
    const adminKey = env.GLOBAL_BANS_ADMIN_KEY;
    const readKey = env.GLOBAL_BANS_READONLY_KEY;
    const auth = request.headers.get('Authorization') || '';
    function isAdmin() {
      return adminKey && auth === `Bearer ${adminKey}`;
    }
    function isReadOnly() {
      if (isAdmin()) return true;
      return readKey && auth === `Bearer ${readKey}`;
    }

    // Read-only GET endpoints for third-party consumers
    if (request.method === 'GET' && (url.pathname === '/global-bans' || url.pathname === '/global-bans/users')) {
      if (!isReadOnly()) return ErrorResponse('unauthorized', 401);
      for (const [key, minimum, maximum] of [['limit', 1, 500], ['offset', 0, 10000]] as const) {
        const raw = url.searchParams.get(key);
        if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum || Number(raw) > maximum)) {
          return ErrorResponse(`invalid_${key}`, 400);
        }
      }

      if (url.pathname === '/global-bans/users') {
        const limit = Math.min(500, Number(url.searchParams.get('limit') || 100));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const res = await env.DB.prepare(`SELECT user_id, COUNT(*) as occurrences, MAX(created_at) as last_seen FROM global_bans GROUP BY user_id ORDER BY occurrences DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
        const users = (res && res.results) ? res.results.map((u: any) => ({ user_id: u.user_id, occurrences: u.occurrences, last_seen: u.last_seen })) : [];
        return JsonResponse({ users, limit, offset });
      }

      // /global-bans
      const all = url.searchParams.get('all') === 'true' || url.searchParams.get('status') === 'all';
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

      let res;
      if (all) {
        res = await env.DB.prepare(`SELECT id, user_id, reason, delete_messages, status, attempts, last_error, created_at FROM global_bans ORDER BY created_at LIMIT ? OFFSET ?`).bind(limit, offset).all();
      } else {
        const status = url.searchParams.get('status') || 'pending';
        res = await env.DB.prepare(`SELECT id, user_id, reason, delete_messages, status, attempts, last_error, created_at FROM global_bans WHERE status = ? ORDER BY created_at LIMIT ? OFFSET ?`).bind(status, limit, offset).all();
      }
      const tasks = (res && res.results) ? res.results : [];
      const safe = tasks.map((t: any) => ({ id: t.id, user_id: t.user_id, reason: t.reason, delete_messages: t.delete_messages, status: t.status, attempts: t.attempts, last_error: t.last_error, created_at: t.created_at }));
      return JsonResponse({ tasks: safe, limit, offset });
    }

    // Admin POST endpoints for creating tasks or reporting results
    const resultMatch = url.pathname.match(/^\/global-bans\/([^/]+)\/result$/);
    if (request.method === 'POST' && (url.pathname === '/global-bans' || resultMatch)) {
      if (!isAdmin()) return ErrorResponse('unauthorized', 401);
      let rawBody: string;
      try { rawBody = await readLimitedText(request.body); }
      catch { return ErrorResponse('input_too_large_or_unreadable', 413); }
      const body: any = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
      if (!body || typeof body !== 'object') return ErrorResponse('invalid_json', 400);

      if (url.pathname === '/global-bans') {
        const user_ids: unknown[] = Array.isArray(body.user_ids) ? body.user_ids : (body.user_id ? [body.user_id] : []);
        if (!user_ids.length) return ErrorResponse('missing_user_ids', 400);
        if (user_ids.length > MAX_JOB_USERS) return ErrorResponse('too_many_users', 400);
        if (!user_ids.every(uid => typeof uid === 'string' && /^\d{15,21}$/.test(uid))) {
          return ErrorResponse('invalid_user_ids', 400);
        }
        if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 512)) return ErrorResponse('invalid_reason', 400);
        const reason = body.reason || '';
        const del = Number(body.delete_messages) || 0;
        if (!Number.isInteger(del) || del < 0 || del > 604800) return ErrorResponse('invalid_delete_messages', 400);
        const requested_by = body.requested_by || null;
        const created = new Date().toISOString();
        const inserted = (user_ids as string[]).map(uid => ({ id: crypto.randomUUID(), user_id: uid }));
        await env.DB.prepare(`INSERT INTO global_bans (id, user_id, requested_by, reason, delete_messages, status, attempts, last_error, created_at, updated_at)
          SELECT json_extract(value, '$.id'), json_extract(value, '$.user_id'), ?2, ?3, ?4, 'pending', 0, NULL, ?5, ?5 FROM json_each(?1)`)
          .bind(JSON.stringify(inserted), requested_by, reason, del, created).run();
        return JsonResponse({ ids: inserted }, 201);
      }

      // POST /global-bans/:id/result
      const id = resultMatch![1];
      const status = body.status;
      if (typeof status !== 'string' || !GLOBAL_BAN_TASK_STATUSES.has(status)) {
        return ErrorResponse(`invalid_status (expected one of: ${[...GLOBAL_BAN_TASK_STATUSES].join(', ')})`, 400);
      }
      const attempts = Number(body.attempts || 0);
      const last_error = body.last_error || null;
      const updated = new Date().toISOString();
      const task = await env.DB.prepare(
        `UPDATE global_bans SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ? RETURNING user_id, reason, requested_by`
      ).bind(status, attempts, last_error, updated, id).first<{ user_id: string; reason: string | null; requested_by: string | null }>();
      if (!task) return ErrorResponse('not_found', 404);

      // Completed tasks put the user on the global ban list (audits and exports read from there)
      if (status === 'completed') {
        await addToGlobalBanListStatement(env, [task.user_id], task.reason, task.requested_by).run();
      }
      return JsonResponse({ ok: true });
    }

    // Verify Discord signature
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const body = await request.text();

    if (!signature || !timestamp) {
      return ErrorResponse('Missing signature headers', 401);
    }

    const isValid = await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return ErrorResponse('Invalid signature', 401);
    }

    // Parse interaction
    const interaction: DiscordInteraction = JSON.parse(body);

    // Handle PING
    if (interaction.type === InteractionType.PING) {
      return JsonResponse({ type: InteractionResponseType.PONG });
    }

    // Handle application commands
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      try {
        // Check rate limit (skipped for special users: saves a Durable Object round trip per command)
        const userId = getInvokingUserId(interaction);
        const rateLimitResult: { allowed: boolean; retryAfter?: number } = isSpecialUser(env, userId)
          ? { allowed: true }
          : await checkRateLimit(env, interaction.guild_id || 'dm', userId || 'unknown');

        if (!rateLimitResult.allowed) {
          return JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `⏰ Rate limit exceeded. Please try again in ${Math.ceil(rateLimitResult.retryAfter || 0)} seconds.`,
              flags: 64, // EPHEMERAL
            },
          });
        }

        // Handle the command
        const response = await handleCommand(interaction, env, ctx);
        return JsonResponse(response);
      } catch (error) {
        console.error('Error handling command:', error);
        return JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '❌ An error occurred while processing your command.',
            flags: 64, // EPHEMERAL
          },
        });
      }
    }

    // Handle button interactions
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      try {
        const response = await handleButtonInteraction(interaction, env, ctx);
        return JsonResponse(response);
      } catch (error) {
        console.error('Error handling button interaction:', error);
        return JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: '❌ An error occurred while processing your interaction.',
            flags: 64, // EPHEMERAL
          },
        });
      }
    }

    // Handle other interaction types
    return ErrorResponse('Unknown interaction type', 400);
  },

  // Native Cron Trigger (see [triggers] in wrangler.toml), free on every plan
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enforceGlobalBans(env));
  },
};

async function checkRateLimit(
  env: Env,
  guildId: string,
  userId: string
): Promise<{ allowed: boolean; retryAfter?: number }> {
  // Get rate limiter DO
  const id = env.RATE_LIMITER.idFromName(`${guildId}:${userId}`);
  const stub = env.RATE_LIMITER.get(id);

  // Check rate limit
  const response = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    body: JSON.stringify({
      guildId,
      userId,
      timestamp: Date.now(),
    }),
  });

  return await response.json();
}

async function handleScheduledGlobalBanCheck(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Verify admin auth
  const adminKey = env.GLOBAL_BANS_ADMIN_KEY;
  const auth = request.headers.get('Authorization') || '';

  if (!adminKey || auth !== `Bearer ${adminKey}`) {
    return ErrorResponse('unauthorized', 401);
  }

  ctx.waitUntil(enforceGlobalBans(env));

  return JsonResponse({ success: true, message: 'Global ban check started' });
}

/**
 * Make sure everyone on the global ban list is banned in every server that opted into
 * automatic enforcement (/toggleautoenforce, off by default). A BanJob reads the ban lists
 * page by page and then bans only where a ban is missing.
 */
async function enforceGlobalBans(env: Env): Promise<void> {
  try {
    const [globalBans, guilds] = await Promise.all([
      getGlobalBanList(env),
      getGuildsWithAutoEnforceEnabled(env),
      // Housekeeping: buttons older than an hour can no longer be used
      env.DB.prepare("DELETE FROM pending_ban_actions WHERE expires_at <= datetime('now')").run(),
      env.DB.prepare("DELETE FROM bot_jobs WHERE status NOT IN ('running', 'cancel_requested') AND updated_at < ?").bind(Date.now() - 7 * 86400000).run(),
    ]);

    if (globalBans.length === 0 || guilds.length === 0) {
      console.log(`Global ban enforcement skipped: ${globalBans.length} banned users, ${guilds.length} servers with auto-enforce`);
      return;
    }

    await startBanJob(env, {
      kind: 'check',
      title: 'Scheduled global ban enforcement',
      targets: guilds.map(guildId => ({ guildId, userIds: [] })),
      reason: 'Global ban enforcement',
      deleteMessageSeconds: 0,
      // A bot's user ID equals its application ID
      moderatorId: env.DISCORD_APPLICATION_ID,
      check: { userIds: globalBans.map(b => b.user_id), variant: 'scheduled', onComplete: 'enforce' },
    });
  } catch (error) {
    console.error('Error during scheduled global ban check:', error);
  }
}
