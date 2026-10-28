import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { DiscordEmbed } from '../types/discord';
import {
  BULK_BAN_MAX_USERS,
  bulkBanUsers,
  editOriginalResponse,
  isSubrequestLimitError,
  mapWithConcurrency,
  sendMessage,
  unbanUser,
} from '../utils/discord';
import { createModerationCases } from '../utils/database';
import { getGlobalBanGuildTargets, setGlobalBansDisabled } from '../utils/databaseExtras';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed, logBulkModerationAction } from '../utils/logging';

/**
 * BanJob Durable Object
 *
 * Runs ban, unban and announcement jobs across many guilds. A Worker invocation on the free
 * plan may only make 50 subrequests and `waitUntil` ends 30s after the response, so long jobs
 * used to stop halfway. Here every alarm is a fresh invocation with its own budget: each run
 * processes as many guilds as fit, saves its progress and schedules the next run.
 *
 * One instance per job (newUniqueId), deleted when the job is done.
 */

export type BanJobKind = 'ban' | 'unban' | 'announce';

export interface BanJobInput {
  kind: BanJobKind;
  /** Shown in the progress and result messages, e.g. "Global mass ban" */
  title: string;
  /** Users to process per guild (ignored for announcements) */
  targets: Array<{ guildId: string; userIds: string[] }>;
  reason: string;
  deleteMessageSeconds: number;
  moderatorId: string;
  /** Extra lines shown above the results */
  notes?: string[];
  announcement?: DiscordEmbed;
  /** Interaction whose original response shows progress and results (omit for cron jobs) */
  interaction?: { applicationId: string; token: string };
}

interface WorkItem {
  guildId: string;
  userIds: string[];
  attempts: number;
}

interface GuildOutcome {
  succeeded: number;
  skipped: number;
  failedUserIds: string[];
  error?: string;
}

interface JobState {
  input: Omit<BanJobInput, 'targets'>;
  queue: WorkItem[];
  totalItems: number;
  totalGuilds: number;
  logChannels: Record<string, string | null> | null;
  outcomes: Record<string, GuildOutcome>;
  createdAt: number;
  runs: number;
  failedRuns: number;
}

// Subrequests (fetch + D1) one alarm run may use; the hard limit is 50
const RUN_BUDGET = 40;
// Reserved for the progress/result edit and the one-time log channel lookup
const RUN_RESERVED = 2;
const CONCURRENCY = 6;
const UNBAN_USERS_PER_ITEM = 10;
const MAX_ITEM_ATTEMPTS = 3;
const MAX_FAILED_RUNS = 5;
// Give Discord time to register the deferred response before the first edit
const FIRST_RUN_DELAY_MS = 1500;
const NEXT_RUN_DELAY_MS = 1000;
// Interaction tokens expire after 15 minutes
const INTERACTION_TOKEN_TTL_MS = 14 * 60 * 1000;

const GUILD_GONE_ERROR = 'Bot not in server (global bans auto-disabled)';

export class BanJob extends DurableObject<Env> {
  async start(input: BanJobInput): Promise<void> {
    const queue: WorkItem[] = [];
    const chunkSize = input.kind === 'unban' ? UNBAN_USERS_PER_ITEM : BULK_BAN_MAX_USERS;

    for (const target of input.targets) {
      if (input.kind === 'announce') {
        queue.push({ guildId: target.guildId, userIds: [], attempts: 0 });
        continue;
      }
      for (let i = 0; i < target.userIds.length; i += chunkSize) {
        queue.push({ guildId: target.guildId, userIds: target.userIds.slice(i, i + chunkSize), attempts: 0 });
      }
    }

    const { targets, ...rest } = input;
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

    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(Date.now() + FIRST_RUN_DELAY_MS);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<JobState>('state');
    if (!state) return;

    state.runs++;

    try {
      let budget = RUN_BUDGET - RUN_RESERVED;

      if (state.logChannels === null) {
        state.logChannels = {};
        if (state.input.kind !== 'unban') {
          const guildIds = [...new Set(state.queue.map(item => item.guildId))];
          for (const t of await getGlobalBanGuildTargets(this.env, guildIds)) {
            state.logChannels[t.guildId] = t.logChannelId;
          }
          budget--;
        }
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
      await mapWithConcurrency(batch, CONCURRENCY, async (item) => {
        const retry = await this.processItem(state, item);
        if (retry) requeue.push(item);
      });
      state.queue.unshift(...requeue);

      if (state.queue.length > 0) {
        await this.ctx.storage.put('state', state);
        await this.ctx.storage.setAlarm(Date.now() + NEXT_RUN_DELAY_MS);
        await this.reportProgress(state);
        return;
      }

      await this.finish(state);
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
        // bulk-ban + case batch + log message
        return 2 + (hasLog ? 1 : 0);
      case 'unban':
        return item.userIds.length;
      case 'announce':
        return 1;
    }
  }

  private outcome(state: JobState, guildId: string): GuildOutcome {
    return (state.outcomes[guildId] ??= { succeeded: 0, skipped: 0, failedUserIds: [] });
  }

  /**
   * Process one work item. Returns true if it should be retried in the next run
   * (only when the subrequest limit was hit before anything was changed).
   */
  private async processItem(state: JobState, item: WorkItem): Promise<boolean> {
    const outcome = this.outcome(state, item.guildId);
    const { input } = state;

    try {
      if (input.kind === 'ban') {
        const result = await bulkBanUsers(this.env, item.guildId, item.userIds, input.reason, input.deleteMessageSeconds);

        if (result.guildGone) {
          outcome.error = GUILD_GONE_ERROR;
          outcome.failedUserIds.push(...item.userIds);
          await setGlobalBansDisabled(this.env, item.guildId);
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
        try {
          const cases = await createModerationCases(this.env, {
            guildId: item.guildId,
            userIds: result.banned,
            moderatorId: input.moderatorId,
            actionType: 'ban',
            reason: input.reason,
          });

          const channelId = state.logChannels?.[item.guildId];
          if (channelId) {
            await logBulkModerationAction(this.env, channelId, {
              actionType: 'ban',
              cases,
              moderatorId: input.moderatorId,
              reason: input.reason,
            });
          }
        } catch (error) {
          console.error(`Recording bans for guild ${item.guildId} failed:`, error);
        }
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
      outcome.error = String((error as any)?.message || error);
      if (input.kind !== 'announce') outcome.failedUserIds.push(...item.userIds);
      return false;
    }
  }

  private canUseInteraction(state: JobState): boolean {
    return !!state.input.interaction && Date.now() - state.createdAt < INTERACTION_TOKEN_TTL_MS;
  }

  private async reportProgress(state: JobState): Promise<void> {
    if (!this.canUseInteraction(state)) return;
    const done = state.totalItems - state.queue.length;
    const { applicationId, token } = state.input.interaction!;
    await editOriginalResponse(applicationId, token, {
      embeds: [createInfoEmbed('🔄 In progress', `${state.input.title}: ${done}/${state.totalItems} batches processed...`)],
      components: [],
    }).catch(err => console.error('Progress update failed:', err));
  }

  private async finish(state: JobState, abortReason?: string): Promise<void> {
    const message = this.buildSummary(state, abortReason);
    console.log(`BanJob finished after ${state.runs} run(s): ${message.split('\n')[0]}`);

    if (this.canUseInteraction(state)) {
      const { applicationId, token } = state.input.interaction!;
      await editOriginalResponse(applicationId, token, {
        embeds: [abortReason ? createErrorEmbed(message) : createSuccessEmbed(message)],
        components: [],
      }).catch(err => console.error('Result update failed:', err));
    }

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
    } else {
      message = `**${input.title} complete.** Sent to ${succeeded} out of ${state.totalGuilds} server(s).`;
    }

    if (abortReason) message += `\n\n⚠️ ${abortReason}`;
    if (input.notes?.length) message += `\n\n${input.notes.join('\n')}`;

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
  const stub = env.BAN_JOBS.get(env.BAN_JOBS.newUniqueId());
  await stub.start(input);
}
