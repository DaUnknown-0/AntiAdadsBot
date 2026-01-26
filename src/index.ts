import { verifyKey } from 'discord-interactions';
import { Env } from './types/env';
import { DiscordInteraction, InteractionType, InteractionResponseType } from './types/discord';
import { RateLimiter } from './durable-objects/RateLimiter';
import { ScheduledActions } from './durable-objects/ScheduledActions';
import { handleCommand } from './commands';
import { JsonResponse, ErrorResponse } from './utils/responses';

// Export Durable Object classes
export { RateLimiter, ScheduledActions };

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
      if (url.pathname === '/global-bans') {
        const user_ids = body.user_ids || (body.user_id ? [body.user_id] : []);
        if (!user_ids.length) return ErrorResponse('missing_user_ids', 400);
        const reason = body.reason || '';
        const del = Number(body.delete_messages) || 0;
        const requested_by = body.requested_by || null;
        const created = new Date().toISOString();
        const inserted: any[] = [];
        for (const uid of user_ids) {
          const id = crypto.randomUUID();
          const sql = `INSERT INTO global_bans (id, user_id, requested_by, reason, delete_messages, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`;
          await env.DB.prepare(sql).bind(id, uid, requested_by, reason, del, created, created).run();
          inserted.push({ id, user_id: uid });
        }
        return JsonResponse({ ids: inserted }, 201);
      }

      // POST /global-bans/:id/result
      const id = resultMatch![1];
      const status = body.status;
      const attempts = Number(body.attempts || 0);
      const last_error = body.last_error || null;
      const updated = new Date().toISOString();
      await env.DB.prepare(`UPDATE global_bans SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`).bind(status, attempts, last_error, updated, id).run();
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
        // Check rate limit
        const rateLimitResult = await checkRateLimit(
          env,
          interaction.guild_id || 'dm',
          interaction.member?.user?.id || interaction.user?.id || 'unknown'
        );

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
        const { handleButtonInteraction } = await import('./commands/moderation/handleButtonInteraction');
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

  ctx.waitUntil(
    (async () => {
      try {
        const { getGuildsWithGlobalBansEnabled, getGlobalBanList } = await import('./utils/databaseExtras');
        const { isUserBanned, banUser } = await import('./utils/discord');

        const guilds = await getGuildsWithGlobalBansEnabled(env);
        const globalBans = await getGlobalBanList(env);

        console.log(`Checking ${globalBans.length} globally banned users across ${guilds.length} servers`);

        let enforcedBans = 0;
        let errors = 0;

        for (const ban of globalBans) {
          for (const guildId of guilds) {
            try {
              const isBanned = await isUserBanned(env, guildId, ban.user_id);

              if (!isBanned) {
                // User should be banned but isn't - enforce the ban
                const success = await banUser(
                  env,
                  guildId,
                  ban.user_id,
                  ban.reason || 'Global ban enforcement',
                  0
                );

                if (success) {
                  enforcedBans++;
                  console.log(`Enforced global ban for user ${ban.user_id} in guild ${guildId}`);
                } else {
                  errors++;
                }
              }
            } catch (err) {
              console.error(`Error checking/enforcing ban for ${ban.user_id} in ${guildId}:`, err);
              errors++;
            }
          }
        }

        console.log(`Global ban check complete. Enforced: ${enforcedBans}, Errors: ${errors}`);
      } catch (error) {
        console.error('Error during scheduled global ban check:', error);
      }
    })()
  );

  return JsonResponse({ success: true, message: 'Global ban check started' });
}
