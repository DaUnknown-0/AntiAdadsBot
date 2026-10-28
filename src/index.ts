import { verifyKey } from 'discord-interactions';
import { Env } from './types/env';
import { DiscordInteraction, InteractionType, InteractionResponseType } from './types/discord';
import { RateLimiter } from './durable-objects/RateLimiter';
import { BanJob, startBanJob } from './durable-objects/BanJob';
import { handleCommand } from './commands';
import { handleButtonInteraction } from './commands/moderation/handleButtonInteraction';
import { JsonResponse, ErrorResponse } from './utils/responses';
import { getInvokingUserId, isSpecialUser } from './utils/permissions';
import { addToGlobalBanListStatement, getGlobalBanList, getGuildsWithGlobalBansEnabled } from './utils/databaseExtras';
import { findMissingBans, invertMissingBans } from './utils/banCheck';

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
      const body: any = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return ErrorResponse('invalid_json', 400);

      if (url.pathname === '/global-bans') {
        const user_ids: unknown[] = Array.isArray(body.user_ids) ? body.user_ids : (body.user_id ? [body.user_id] : []);
        if (!user_ids.length) return ErrorResponse('missing_user_ids', 400);
        if (!user_ids.every(uid => typeof uid === 'string' && /^\d{15,21}$/.test(uid))) {
          return ErrorResponse('invalid_user_ids', 400);
        }
        const reason = body.reason || '';
        const del = Number(body.delete_messages) || 0;
        const requested_by = body.requested_by || null;
        const created = new Date().toISOString();
        const inserted = (user_ids as string[]).map(uid => ({ id: crypto.randomUUID(), user_id: uid }));
        const sql = `INSERT INTO global_bans (id, user_id, requested_by, reason, delete_messages, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`;
        // One batch counts as a single D1 query, however many users are inserted
        await env.DB.batch(inserted.map(row => env.DB.prepare(sql).bind(row.id, row.user_id, requested_by, reason, del, created, created)));
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
 * Make sure everyone on the global ban list is banned in every enabled server.
 * Reads each server's ban list (one request per 1000 bans) and hands only the missing
 * bans to a BanJob, so the run stays far below the 50-subrequest limit.
 */
async function enforceGlobalBans(env: Env): Promise<void> {
  try {
    const [globalBans, guilds] = await Promise.all([
      getGlobalBanList(env),
      getGuildsWithGlobalBansEnabled(env),
      // Housekeeping: buttons older than an hour can no longer be used
      env.DB.prepare("DELETE FROM pending_ban_actions WHERE expires_at <= datetime('now')").run(),
    ]);

    if (globalBans.length === 0 || guilds.length === 0) {
      console.log(`Global ban check skipped: ${globalBans.length} banned users, ${guilds.length} servers`);
      return;
    }

    const report = await findMissingBans(env, globalBans.map(b => b.user_id), guilds, 44);
    const missingCount = [...report.missing.values()].reduce((sum, g) => sum + g.length, 0);

    console.log(
      `Checked ${globalBans.length} globally banned users across ${report.checkedGuilds.length} servers: ` +
      `${missingCount} missing bans, ${report.uncheckedGuilds.length} servers not checked, ${report.goneGuilds.length} servers left`
    );

    if (missingCount === 0) return;

    const byGuild = invertMissingBans(Object.fromEntries(report.missing));
    await startBanJob(env, {
      kind: 'ban',
      title: 'Scheduled global ban enforcement',
      targets: [...byGuild.entries()].map(([guildId, userIds]) => ({ guildId, userIds })),
      reason: 'Global ban enforcement',
      deleteMessageSeconds: 0,
      // A bot's user ID equals its application ID
      moderatorId: env.DISCORD_APPLICATION_ID,
    });
  } catch (error) {
    console.error('Error during scheduled global ban check:', error);
  }
}
