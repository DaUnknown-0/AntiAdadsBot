import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { DiscordEmbed } from '../types/discord';
import {
  BULK_BAN_MAX_USERS,
  banUser,
  bulkBanUsers,
  editOriginalResponse,
  fetchGuildBanPage,
  isSubrequestLimitError,
  mapWithConcurrency,
  sendMessage,
  unbanUser,
} from '../utils/discord';
import { createModerationCases } from '../utils/database';
import { addUsersToGlobalBanList, removeUserFromGlobalBanList, createPendingBanAction, getGlobalBanGuildTargets, setGlobalBansDisabled } from '../utils/databaseExtras';
import { BanCheckVariant, buildBanCheckMessage } from '../utils/banCheck';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed, logBulkModerationAction } from '../utils/logging';
import { validateJobSize } from '../utils/jobLimits';

/**
 * BanJob Durable Object
 *
 * Runs ban, unban, announcement and ban check jobs across many guilds. A Worker invocation on
 * the free plan may only make 50 subrequests and `waitUntil` ends 30s after the response, so
 * long jobs used to stop halfway. Here every alarm is a fresh invocation with its own budget:
 * each run processes as much as fits, saves its progress and schedules the next run.
 *
 * One instance per job (newUniqueId), deleted when the job is done.
 */

export type BanJobKind = 'ban' | 'unban' | 'announce' | 'check';

export interface BanCheckInput {
  /** Users that should be banned in every target guild */
  userIds: string[];
  variant: BanCheckVariant;
  /** report: show the result with a confirmation button; enforce: ban the missing users right away */
  onComplete: 'report' | 'enforce';
  /** Set when /checkbans was limited to one server */
  singleServer?: string;
}

export interface BanJobInput {
  requestKey?: string;
  globalList?: { action: 'add' | 'remove'; userIds: string[] };
  jobId?: string;
  kind: BanJobKind;
  /** Shown in the progress and result messages, e.g. "Global mass ban" */
  title: string;
  /** Users to process per guild (ignored for announcements and checks) */
  targets: Array<{ guildId: string; userIds: string[] }>;
  /** Ban/unban reason; for checks the reason stored with the confirmation button */
  reason: string;
  deleteMessageSeconds: number;
  moderatorId: string;
  /** Extra lines shown above the results */
  notes?: string[];
  announcement?: DiscordEmbed;
  check?: BanCheckInput;
  /** Interaction whose original response shows progress and results (omit for cron jobs) */
  interaction?: { applicationId: string; token: string };
}

interface WorkItem {
  userListKey?: string;
  userCount?: number;
  guildId: string;
  userIds: string[];
  attempts: number;
  /** Ban list pagination cursor (checks only) */
  after?: string;
  pages?: number;
  /** Ban one by one (bot lacks Manage Server for the bulk ban endpoint) */
  single?: boolean;
  /** Cases created so far for a single-ban item, logged together when it is done */
  cases?: Array<{ userId: string; caseNumber: number }>;
  /** How often Discord rate limited this item so far */
  rateLimits?: number;
}

interface GuildOutcome {
  succeeded: number;
  skipped: number;
  failedUserIds: string[];
  error?: string;
}

interface CheckState {
  variant: BanCheckVariant;
  onComplete: 'report' | 'enforce';
  singleServer?: string;
  userCount: number;
  checked: string[];
  gone: string[];
  unchecked: Array<{ guildId: string; reason: string }>;
}

interface JobState {
  input: Omit<BanJobInput, 'targets' | 'check'>;
  check?: CheckState;
  queue: WorkItem[];
  totalItems: number;
  totalGuilds: number;
  logChannels: Record<string, string | null> | null;
  outcomes: Record<string, GuildOutcome>;
  /** Guilds where the bulk ban was refused for missing permissions */
  singleBanGuilds?: string[];
  createdAt: number;
  runs: number;
  failedRuns: number;
}

// Subrequests (fetch + D1) one alarm run may use; the hard limit is 50
const RUN_BUDGET = 40;
// Reserved for the progress/result edit plus one D1 query (log channels or confirmation button)
const RUN_RESERVED = 4;
const CONCURRENCY = 6;
const UNBAN_USERS_PER_ITEM = 10;
// Single bans per run and item: two such items (17 + case insert + log each) fit into one run
const SINGLE_BANS_PER_RUN = 17;
const MAX_ITEM_ATTEMPTS = 3;
const MAX_FAILED_RUNS = 5;
// A rate limited item goes back into the queue and the next run waits for Discord's retry-after
const MAX_RATE_LIMIT_RETRIES = 6;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000;
// 50 pages of 1000 bans; larger ban lists are reported as not checked
const MAX_CHECK_PAGES = 50;
// Give Discord time to register the deferred response before the first edit
const FIRST_RUN_DELAY_MS = 1500;
const NEXT_RUN_DELAY_MS = 1000;
// Interaction tokens expire after 15 minutes
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;

const GUILD_GONE_ERROR = 'Bot not in server (global bans auto-disabled)';
const CHECK_TARGETS_KEY = 'check:targets';
const missingKey = (guildId: string) => `check:missing:${guildId}`;

export class BanJob extends DurableObject<Env> {
  /** Users a check compares against, loaded once per alarm run */
  private checkTargets: string[] | null = null;
  /** Longest rate limit wait requested during the current alarm run */
  private nextRunDelayMs = 0;

  async start(input: BanJobInput): Promise<void> {
    validateJobSize(input.targets, input.check?.userIds);
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024) throw new Error('Job input exceeds 1 MiB. Split the request.');
    const queue: WorkItem[] = [];
    const lists = new Map<string, string>();
    const chunkSize = input.kind === 'unban' ? UNBAN_USERS_PER_ITEM : BULK_BAN_MAX_USERS;

    for (const target of input.targets) {
      if (input.kind === 'announce' || input.kind === 'check') {
        queue.push({ guildId: target.guildId, userIds: [], attempts: 0 });
        continue;
      }
      for (let i = 0; i < target.userIds.length; i += chunkSize) {
        const users = target.userIds.slice(i, i + chunkSize);
        const serialized = JSON.stringify(users);
        let key = lists.get(serialized);
        if (!key) {
          key = `users:${lists.size}`;
          lists.set(serialized, key);
          await this.ctx.storage.put(key, users);
        }
        queue.push({ guildId: target.guildId, userIds: [], userListKey: key, userCount: users.length, attempts: 0 });
      }
    }

    const { targets, check, ...rest } = input;
    const state: JobState = {
      input: rest,
      queue,
      totalItems: queue.length,
      totalGuilds: targets.length,
      logChannels: null,
      outcomes: {},
      createdAt: Date.now(),
      runs: 0,
      failedRuns: 0,
    };

    if (input.kind === 'check') {
      if (!check) throw new Error('A check job needs check options');
      state.check = {
        variant: check.variant,
        onComplete: check.onComplete,
        singleServer: check.singleServer,
        userCount: check.userIds.length,
        checked: [],
        gone: [],
        unchecked: [],
      };
      // Kept apart from the state so the per-run state write stays small
      await this.ctx.storage.put(CHECK_TARGETS_KEY, check.userIds);
    }

    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(Date.now() + FIRST_RUN_DELAY_MS);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<JobState>('state');
    if (!state) return;

    if (state.input.jobId) {
      const job = await this.env.DB.prepare('SELECT status, lease_until FROM bot_jobs WHERE id = ?').bind(state.input.jobId).first<{ status: string; lease_until: number }>();
      if (!job || job.status !== 'running' || job.lease_until < Date.now()) {
        await this.finish(state, 'Job cancelled or lease expired.', 'cancelled');
        return;
      }
      await this.env.DB.prepare('UPDATE bot_jobs SET updated_at = ?, lease_until = ? WHERE id = ? AND status = ?')
        .bind(Date.now(), Date.now() + 7200000, state.input.jobId, 'running').run();
    }

    state.runs++;
    this.nextRunDelayMs = 0;

    try {
      let budget = RUN_BUDGET - RUN_RESERVED;

      if (state.logChannels === null) {
        state.logChannels = {};
        if (state.input.kind === 'ban' || state.input.kind === 'announce') {
          const guildIds = [...new Set(state.queue.map(item => item.guildId))];
          for (const t of await getGlobalBanGuildTargets(this.env, guildIds)) {
            state.logChannels[t.guildId] = t.logChannelId;
          }
          budget--;
        }
      }

      if (state.input.kind === 'check') {
        this.checkTargets = (await this.ctx.storage.get<string[]>(CHECK_TARGETS_KEY)) || [];
      }

      // Take items from the front of the queue while they fit into this run's budget
      const batch: WorkItem[] = [];
      while (state.queue.length > 0) {
        const cost = this.itemCost(state, state.queue[0]);
        if (batch.length > 0 && cost > budget) break;
        budget -= cost;
        batch.push(state.queue.shift()!);
      }

      const requeue: WorkItem[] = [];
      let storageFailure: unknown;
      await mapWithConcurrency(batch, CONCURRENCY, async (item) => {
        let loaded = false;
        try {
          if (item.userListKey) {
            const users = await this.ctx.storage.get<string[]>(item.userListKey);
            if (!users) throw new Error('Missing stored user list');
            item.userIds = users;
          }
          loaded = true;
          const again = await this.processItem(state, item);
          if (again) {
            if (item.userListKey) {
              // Each resumed item owns its remaining list; shared initial lists stay immutable.
              item.userListKey = `remaining:${crypto.randomUUID()}`;
              await this.ctx.storage.put(item.userListKey, item.userIds);
              item.userCount = item.userIds.length;
              item.userIds = [];
            }
            requeue.push(item);
          }
        } catch (error) {
          // Keep the remaining users inline if persisting a resumed list failed.
          // Wait for all workers before saving the recovered queue.
          if (loaded) delete item.userListKey;
          requeue.push(item);
          storageFailure = error;
        }
      });
      state.queue.unshift(...requeue);
      if (storageFailure) throw storageFailure;

      if (state.queue.length > 0) {
        await this.ctx.storage.put('state', state);
        await this.ctx.storage.setAlarm(Date.now() + Math.max(NEXT_RUN_DELAY_MS, this.nextRunDelayMs));
        await this.reportProgress(state);
        return;
      }

      if (state.input.kind === 'check') {
        await this.finishCheck(state);
      } else {
        await this.finish(state);
      }
    } catch (error) {
      console.error(`BanJob run ${state.runs} failed:`, error);
      state.failedRuns++;

      if (state.failedRuns >= MAX_FAILED_RUNS) {
        await this.finish(state, `Job aborted after ${state.failedRuns} failed runs: ${String((error as any)?.message || error)}`);
        return;
      }

      await this.ctx.storage.put('state', state);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }

  private itemCost(state: JobState, item: WorkItem): number {
    const hasLog = !!state.logChannels?.[item.guildId];
    switch (state.input.kind) {
      case 'ban':
        if (this.usesSingleBans(state, item)) {
          // one request per user + case insert + log message
          return Math.min(item.userCount ?? item.userIds.length, SINGLE_BANS_PER_RUN) + 1 + (hasLog ? 1 : 0);
        }
        // bulk-ban + case insert + log message
        return 2 + (hasLog ? 1 : 0);
      case 'unban':
        return item.userCount ?? item.userIds.length;
      case 'announce':
      case 'check':
        return 1;
    }
  }

  private outcome(state: JobState, guildId: string): GuildOutcome {
    return (state.outcomes[guildId] ??= { succeeded: 0, skipped: 0, failedUserIds: [] });
  }

  /**
   * Process one work item. Returns true if it should run again in the next run: after hitting
   * the subrequest limit before anything was changed, or to read the next page of a ban list.
   */
  private async processItem(state: JobState, item: WorkItem): Promise<boolean> {
    const outcome = this.outcome(state, item.guildId);
    const { input } = state;

    try {
      if (input.kind === 'check') {
        return await this.processCheckItem(state, item);
      }

      if (input.kind === 'ban') {
        if (this.usesSingleBans(state, item)) {
          item.single = true;
          return await this.processSingleBans(state, item);
        }

        const result = await bulkBanUsers(this.env, item.guildId, item.userIds, input.reason, input.deleteMessageSeconds);

        if (result.missingPermissions) {
          // Many servers do not grant Manage Server: ban one by one instead (needs only Ban Members)
          state.singleBanGuilds ??= [];
          if (!state.singleBanGuilds.includes(item.guildId)) state.singleBanGuilds.push(item.guildId);
          item.single = true;
          return true;
        }

        if (result.guildGone) {
          outcome.error = GUILD_GONE_ERROR;
          outcome.failedUserIds.push(...item.userIds);
          await setGlobalBansDisabled(this.env, item.guildId);
          return false;
        }
        if (result.rateLimited) {
          // Nobody was banned: try the whole item again once Discord allows it
          if (this.deferForRateLimit(item, result.rateLimited.retryAfterMs)) return true;
          outcome.error = result.error;
          outcome.failedUserIds.push(...item.userIds);
          return false;
        }
        if (result.error) {
          outcome.error = result.error;
          outcome.failedUserIds.push(...result.failed);
          return false;
        }

        outcome.succeeded += result.banned.length;
        outcome.failedUserIds.push(...result.failed);

        // The ban itself succeeded: never retry from here on, or users would be banned twice
        const cases = await this.recordCases(state, item.guildId, result.banned);
        await this.logBans(state, item.guildId, cases);
        return false;
      }

      if (input.kind === 'unban') {
        for (let i = 0; i < item.userIds.length; i++) {
          const userId = item.userIds[i];
          try {
            const result = await unbanUser(this.env, item.guildId, userId, input.reason);
            if (result.status === 'unbanned') outcome.succeeded++;
            else if (result.status === 'not_banned') outcome.skipped++;
            else if (result.status === 'guild_gone') {
              outcome.error = GUILD_GONE_ERROR;
              outcome.failedUserIds.push(...item.userIds.slice(i));
              await setGlobalBansDisabled(this.env, item.guildId);
              return false;
            } else if (result.status === 'rate_limited') {
              // Keep the users that were not processed yet for a later run
              item.userIds = item.userIds.slice(i);
              if (this.deferForRateLimit(item, result.retryAfterMs)) return true;
              outcome.error = result.error;
              outcome.failedUserIds.push(...item.userIds);
              return false;
            } else {
              outcome.error = result.error;
              outcome.failedUserIds.push(userId);
            }
          } catch (error) {
            if (!isSubrequestLimitError(error)) throw error;
            // Retry only the users that were not processed yet
            item.userIds = item.userIds.slice(i);
            return ++item.attempts < MAX_ITEM_ATTEMPTS;
          }
        }
        return false;
      }

      // announce
      const channelId = state.logChannels?.[item.guildId];
      if (!channelId) {
        outcome.error = 'No log channel configured';
        return false;
      }
      const message = await sendMessage(this.env, channelId, undefined, input.announcement ? [input.announcement] : []);
      if (message) outcome.succeeded++;
      else outcome.error = 'Failed to send message';
      return false;
    } catch (error) {
      if (isSubrequestLimitError(error) && ++item.attempts < MAX_ITEM_ATTEMPTS) {
        return true;
      }
      if (input.kind === 'check') {
        state.check!.unchecked.push({ guildId: item.guildId, reason: String((error as any)?.message || error) });
        await this.ctx.storage.delete(missingKey(item.guildId));
        return false;
      }
      outcome.error = String((error as any)?.message || error);
      if (input.kind !== 'announce') outcome.failedUserIds.push(...item.userIds);
      return false;
    }
  }

  /**
   * Discord still rate limits this item after the inline retries. Returns true if it should be
   * requeued (the next run then waits for the retry-after), false once it was limited too often.
   */
  private deferForRateLimit(item: WorkItem, retryAfterMs?: number): boolean {
    item.rateLimits = (item.rateLimits || 0) + 1;
    if (item.rateLimits > MAX_RATE_LIMIT_RETRIES) return false;

    const wait = Math.min(Math.max(retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, NEXT_RUN_DELAY_MS), MAX_RATE_LIMIT_WAIT_MS);
    this.nextRunDelayMs = Math.max(this.nextRunDelayMs, wait);
    console.warn(`BanJob: guild ${item.guildId} rate limited (${item.rateLimits}/${MAX_RATE_LIMIT_RETRIES}), next run in ${wait}ms`);
    return true;
  }

  private usesSingleBans(state: JobState, item: WorkItem): boolean {
    return !!item.single || !!state.singleBanGuilds?.includes(item.guildId);
  }

  /**
   * Fallback without Manage Server: ban up to SINGLE_BANS_PER_RUN users of the item one by one,
   * keep the rest for the next run, and log the whole item once it is done.
   */
  private async processSingleBans(state: JobState, item: WorkItem): Promise<boolean> {
    const { input } = state;
    const outcome = this.outcome(state, item.guildId);
    const chunk = item.userIds.slice(0, SINGLE_BANS_PER_RUN);
    const banned: string[] = [];
    let processed = 0;
    let hitLimit = false;
    let stopGuild = false;
    let rateLimited: { retryAfterMs?: number; error?: string } | null = null;

    for (const userId of chunk) {
      try {
        const result = await banUser(this.env, item.guildId, userId, input.reason, input.deleteMessageSeconds);
        if (result.status === 'rate_limited') {
          // This user was not banned: keep it and the rest for a later run
          rateLimited = result;
          break;
        }
        processed++;
        if (result.status === 'banned') {
          banned.push(userId);
        } else if (result.status === 'guild_gone' || result.status === 'missing_permissions') {
          // Nothing else will work in this guild: fail the rest of the item
          outcome.error = result.status === 'guild_gone' ? GUILD_GONE_ERROR : result.error;
          outcome.failedUserIds.push(...item.userIds.slice(processed - 1));
          if (result.status === 'guild_gone') await setGlobalBansDisabled(this.env, item.guildId);
          stopGuild = true;
          break;
        } else {
          outcome.error = result.error;
          outcome.failedUserIds.push(userId);
        }
      } catch (error) {
        if (isSubrequestLimitError(error)) {
          hitLimit = true;
          break;
        }
        processed++;
        outcome.error = String((error as any)?.message || error);
        outcome.failedUserIds.push(userId);
      }
    }

    outcome.succeeded += banned.length;
    (item.cases ??= []).push(...(await this.recordCases(state, item.guildId, banned)));
    item.userIds = stopGuild ? [] : item.userIds.slice(processed);

    if (hitLimit && ++item.attempts >= MAX_ITEM_ATTEMPTS) {
      outcome.error = 'Cloudflare subrequest limit';
      outcome.failedUserIds.push(...item.userIds);
      item.userIds = [];
    }

    if (rateLimited && item.userIds.length > 0 && !this.deferForRateLimit(item, rateLimited.retryAfterMs)) {
      outcome.error = rateLimited.error;
      outcome.failedUserIds.push(...item.userIds);
      item.userIds = [];
    }

    if (item.userIds.length > 0) return true;

    await this.logBans(state, item.guildId, item.cases);
    return false;
  }

  private async recordCases(state: JobState, guildId: string, userIds: string[]): Promise<Array<{ userId: string; caseNumber: number }>> {
    try {
      return await createModerationCases(this.env, {
        guildId,
        userIds,
        moderatorId: state.input.moderatorId,
        actionType: 'ban',
        reason: state.input.reason,
      });
    } catch (error) {
      console.error(`Recording bans for guild ${guildId} failed:`, error);
      return [];
    }
  }

  private async logBans(state: JobState, guildId: string, cases: Array<{ userId: string; caseNumber: number }>): Promise<void> {
    const channelId = state.logChannels?.[guildId];
    if (!channelId || cases.length === 0) return;
    await logBulkModerationAction(this.env, channelId, {
      actionType: 'ban',
      cases,
      moderatorId: state.input.moderatorId,
      reason: state.input.reason,
    });
  }

  /**
   * Read one page of a guild's ban list and drop every target user found on it.
   * What is left after the last page are the users missing a ban in that guild.
   */
  private async processCheckItem(state: JobState, item: WorkItem): Promise<boolean> {
    const check = state.check!;
    const key = missingKey(item.guildId);
    const page = await fetchGuildBanPage(this.env, item.guildId, item.after);

    if (page.guildGone) {
      check.gone.push(item.guildId);
      await setGlobalBansDisabled(this.env, item.guildId);
      await this.ctx.storage.delete(key);
      return false;
    }
    if (page.error) {
      check.unchecked.push({ guildId: item.guildId, reason: page.error });
      await this.ctx.storage.delete(key);
      return false;
    }

    const remaining = (await this.ctx.storage.get<string[]>(key)) || this.checkTargets || [];
    const banned = new Set(page.ids);
    const stillMissing = remaining.filter(userId => !banned.has(userId));
    item.pages = (item.pages || 0) + 1;

    // Done after the last page, or early once every target user was found
    if (page.done || stillMissing.length === 0) {
      check.checked.push(item.guildId);
      if (stillMissing.length > 0) await this.ctx.storage.put(key, stillMissing);
      else await this.ctx.storage.delete(key);
      return false;
    }

    if (item.pages >= MAX_CHECK_PAGES) {
      check.unchecked.push({ guildId: item.guildId, reason: `Ban list too long (over ${MAX_CHECK_PAGES * 1000} bans)` });
      await this.ctx.storage.delete(key);
      return false;
    }

    await this.ctx.storage.put(key, stillMissing);
    item.after = page.lastId;
    return true;
  }

  private canUseInteraction(state: JobState): boolean {
    return !!state.input.interaction && Date.now() - state.createdAt < INTERACTION_TOKEN_TTL_MS;
  }

  private async reportProgress(state: JobState): Promise<void> {

    let text = state.check
      ? `${state.input.title}: ${state.check.checked.length + state.check.gone.length + state.check.unchecked.length}/${state.totalGuilds} servers checked...`
      : `${state.input.title}: ${state.totalItems - state.queue.length}/${state.totalItems} batches processed...`;
    if (this.nextRunDelayMs > 3000) {
      text += `\n\n⏳ Discord rate limit: continuing in ${Math.ceil(this.nextRunDelayMs / 1000)}s.`;
    }
    if (state.input.jobId) {
      text += `\nJob ID: ${state.input.jobId}`;
      await this.env.DB.prepare('UPDATE bot_jobs SET summary = ?, updated_at = ? WHERE id = ?').bind(text, Date.now(), state.input.jobId).run();
    }
    if (!this.canUseInteraction(state)) return;

    const { applicationId, token } = state.input.interaction!;
    await editOriginalResponse(applicationId, token, {
      embeds: [createInfoEmbed('🔄 In progress', text)],
      components: [],
    }).catch(err => console.error('Progress update failed:', err));
  }

  /**
   * End of a check: either report the result with a confirmation button,
   * or (hourly enforcement) turn this job into a ban job for the missing bans.
   */
  private async finishCheck(state: JobState): Promise<void> {
    const check = state.check!;

    const missingByGuild = new Map<string, string[]>();
    for (const guildId of check.checked) {
      const missing = await this.ctx.storage.get<string[]>(missingKey(guildId));
      if (missing?.length) missingByGuild.set(guildId, missing);
    }

    const summary =
      `Checked ${check.userCount} user(s) across ${check.checked.length} server(s); ` +
      `${check.unchecked.length} not checked, ${check.gone.length} left.`;

    if (check.onComplete === 'enforce') {
      const missingCount = [...missingByGuild.values()].reduce((sum, users) => sum + users.length, 0);
      console.log(`${state.input.title}: ${summary} ${missingCount} missing bans.`);

      await this.ctx.storage.deleteAll();
      if (missingCount === 0) {
        await this.saveResult(state, summary, 'completed');
        return;
      }

      await this.start({
        ...state.input,
        kind: 'ban',
        targets: [...missingByGuild.entries()].map(([guildId, userIds]) => ({ guildId, userIds })),
        notes: [summary],
      });
      return;
    }

    const missingByUser = new Map<string, string[]>();
    for (const [guildId, userIds] of missingByGuild) {
      for (const userId of userIds) {
        const guilds = missingByUser.get(userId) || [];
        guilds.push(guildId);
        missingByUser.set(userId, guilds);
      }
    }

    const actionId = missingByUser.size > 0
      ? await createPendingBanAction(this.env, Object.fromEntries(missingByUser), state.input.reason, state.input.moderatorId)
      : null;

    const { message, components } = buildBanCheckMessage(
      {
        variant: check.variant,
        userCount: check.userCount,
        singleServer: check.singleServer,
        checkedGuilds: check.checked,
        goneGuilds: check.gone,
        uncheckedGuilds: check.unchecked,
        missing: missingByUser,
      },
      actionId
    );

    if (this.canUseInteraction(state)) {
      const { applicationId, token } = state.input.interaction!;
      const warn = check.variant === 'audit' && missingByUser.size > 0;
      await editOriginalResponse(applicationId, token, {
        embeds: [warn ? createErrorEmbed(message) : createSuccessEmbed(message)],
        components,
      }).catch(err => console.error('Result update failed:', err));
    }

    await this.saveResult(state, message, 'completed');
    await this.ctx.storage.deleteAll();
  }

  private async saveResult(state: JobState, summary: string, status: string): Promise<void> {
    if (!state.input.jobId) return;
    await this.env.DB.prepare('UPDATE bot_jobs SET status = ?, summary = ?, updated_at = ?, lease_until = 0 WHERE id = ?')
      .bind(status, summary.slice(0, 8000), Date.now(), state.input.jobId).run();
  }

  private async finish(state: JobState, abortReason?: string, status?: string): Promise<void> {
    const message = this.buildSummary(state, abortReason);
    console.log(`BanJob finished after ${state.runs} run(s): ${message.split('\n')[0]}`);

    if (this.canUseInteraction(state)) {
      const { applicationId, token } = state.input.interaction!;
      await editOriginalResponse(applicationId, token, {
        embeds: [abortReason ? createErrorEmbed(message) : createSuccessEmbed(message)],
        components: [],
      }).catch(err => console.error('Result update failed:', err));
    }

    await this.saveResult(state, message, status || (abortReason ? 'failed' : 'completed'));
    await this.ctx.storage.deleteAll();
  }

  private buildSummary(state: JobState, abortReason?: string): string {
    const { input } = state;
    const outcomes = Object.entries(state.outcomes);
    const succeeded = outcomes.reduce((sum, [, o]) => sum + o.succeeded, 0);
    const skipped = outcomes.reduce((sum, [, o]) => sum + o.skipped, 0);
    const failed = outcomes.reduce((sum, [, o]) => sum + o.failedUserIds.length, 0);

    let message: string;
    if (input.kind === 'ban') {
      message = `**${input.title} complete.** Successes: ${succeeded}, Failures: ${failed}`;
    } else if (input.kind === 'unban') {
      message = `**${input.title} complete.** Unbanned in ${succeeded} server(s), not banned in ${skipped}, failed in ${failed}`;
    } else if (input.kind === 'announce') {
      message = `**${input.title} complete.** Sent to ${succeeded} out of ${state.totalGuilds} server(s).`;
    } else {
      message = `**${input.title} stopped.**`;
    }

    if (abortReason) message = message.replace(' complete.', ' stopped.') + `\n\n⚠️ ${abortReason}`;
    if (input.notes?.length) message += `\n\n${input.notes.join('\n')}`;
    if (state.singleBanGuilds?.length) {
      message += `\n\nℹ️ ${state.singleBanGuilds.length} server(s) without the Manage Server permission: users were banned one by one (slower, same result).`;
    }

    const failureLines: string[] = [];
    for (const [guildId, o] of outcomes) {
      if (o.error) {
        const users = o.failedUserIds.length;
        failureLines.push(`• Server ID: ${guildId}${users ? ` (${users} user${users > 1 ? 's' : ''})` : ''} - ${o.error}`);
      } else if (o.failedUserIds.length > 0) {
        const users = o.failedUserIds.length;
        failureLines.push(
          input.kind === 'ban'
            ? `• Server ID: ${guildId} (${users} user${users > 1 ? 's' : ''}) - Not banned (already banned, unknown user or higher role)`
            : `• Server ID: ${guildId} (${users} user${users > 1 ? 's' : ''}) - Unban failed`
        );
      }
    }

    if (failureLines.length > 0) {
      message += '\n\n**Failed Servers:**';
      // Embed descriptions are capped at 4096 characters
      for (let i = 0; i < failureLines.length; i++) {
        if (message.length + failureLines[i].length > 3900) {
          message += `\n... and ${failureLines.length - i} more`;
          break;
        }
        message += `\n${failureLines[i]}`;
      }
    }

    return message;
  }
}

/**
 * Hand a job to a fresh BanJob instance. Costs one Durable Object request.
 */
export async function startBanJob(env: Env, input: BanJobInput): Promise<void> {
  validateJobSize(input.targets, input.check?.userIds);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024) throw new Error('Job input exceeds 1 MiB. Split the request.');
  const id = env.BAN_JOBS.newUniqueId();
  const now = Date.now();
  const key = input.requestKey || input.interaction?.token || null;
  // Hash the interaction token; never persist credentials in the job index.
  const digest = key ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)) : null;
  const requestKey = digest ? Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') : null;
  await env.DB.prepare("UPDATE bot_jobs SET status = 'failed', summary = 'Lease expired', updated_at = ? WHERE status IN ('running', 'cancel_requested') AND lease_until < ?").bind(now, now).run();
  if (requestKey && await env.DB.prepare('SELECT id FROM bot_jobs WHERE request_key = ?').bind(requestKey).first()) return;
  try {
    await env.DB.prepare("INSERT INTO bot_jobs (id, request_key, title, moderator_id, status, created_at, updated_at, lease_until) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)")
      .bind(id.toString(), requestKey, input.title, input.moderatorId, now, now, now + 7200000).run();
  } catch (error) {
    if (requestKey && await env.DB.prepare('SELECT id FROM bot_jobs WHERE request_key = ?').bind(requestKey).first()) return;
    if (await env.DB.prepare("SELECT id FROM bot_jobs WHERE status IN ('running', 'cancel_requested')").first()) throw new Error('Another moderation job is running. Use /job-status and try again after it finishes.');
    throw error;
  }
  try {
    if (input.globalList?.action === 'add') await addUsersToGlobalBanList(env, input.globalList.userIds, input.reason, input.moderatorId, input.deleteMessageSeconds);
    if (input.globalList?.action === 'remove') {
      for (const userId of input.globalList.userIds) await removeUserFromGlobalBanList(env, userId);
    }
    const { globalList: _globalList, ...jobInput } = input;
    await env.BAN_JOBS.get(id).start({ ...jobInput, jobId: id.toString() });
    if (input.interaction) await editOriginalResponse(input.interaction.applicationId, input.interaction.token, { content: `Job started. ID: \`${id}\`\nUse /job-status to retrieve results.` }).catch(() => false);
  } catch (error) {
    await env.DB.prepare("UPDATE bot_jobs SET status = 'failed', summary = 'Could not start job', updated_at = ? WHERE id = ?").bind(Date.now(), id.toString()).run();
    throw error;
  }
}
