import { Env } from '../types/env';
import { DiscordEmbed } from '../types/discord';
import { sendMessage } from './discord';
import { getGuildConfig } from './permissions';

/**
 * Logging and audit trail utilities
 */

const COLORS = {
  BAN: 0xff0000, // Red
  UNBAN: 0x00ff00, // Green
  KICK: 0xff6600, // Orange
  TIMEOUT: 0xffaa00, // Yellow-Orange
  UNTIMEOUT: 0x00ff00, // Green
  WARN: 0xffff00, // Yellow
  MUTE: 0x666666, // Gray
  UNMUTE: 0x00ff00, // Green
  PURGE: 0x9900ff, // Purple
  INFO: 0x0099ff, // Blue
};

/**
 * Log a moderation action to the configured log channel
 */
export async function logModerationAction(
  env: Env,
  guildId: string,
  moderationCase: {
    caseNumber: number;
    actionType: string;
    userId: string;
    moderatorId: string;
    reason?: string;
    duration?: number;
    expiresAt?: string;
  }
): Promise<string | null> {
  try {
    const config = await getGuildConfig(env, guildId);
    if (!config || !config.mod_log_channel_id) {
      return null;
    }

    const embed = createModerationEmbed(moderationCase);
    const message = await sendMessage(env, config.mod_log_channel_id, undefined, [embed]);

    return message?.id || null;
  } catch (error) {
    console.error('Error logging moderation action:', error);
    return null;
  }
}

/**
 * Log one action against many users as a single message (one subrequest per guild instead of one per user)
 */
export async function logBulkModerationAction(
  env: Env,
  channelId: string,
  action: {
    actionType: string;
    cases: Array<{ userId: string; caseNumber: number }>;
    moderatorId: string;
    reason?: string;
  }
): Promise<string | null> {
  if (action.cases.length === 0) return null;

  try {
    const embed = action.cases.length === 1
      ? createModerationEmbed({ ...action.cases[0], actionType: action.actionType, moderatorId: action.moderatorId, reason: action.reason })
      : createBulkModerationEmbed(action);
    const message = await sendMessage(env, channelId, undefined, [embed]);
    return message?.id || null;
  } catch (error) {
    console.error('Error logging bulk moderation action:', error);
    return null;
  }
}

function createBulkModerationEmbed(action: {
  actionType: string;
  cases: Array<{ userId: string; caseNumber: number }>;
  moderatorId: string;
  reason?: string;
}): DiscordEmbed {
  const lines: string[] = [];
  let length = 0;
  for (const c of action.cases) {
    const line = `<@${c.userId}> (\`${c.userId}\`) · Case #${c.caseNumber}`;
    // Embed descriptions are capped at 4096 characters
    if (length + line.length + 1 > 3900) {
      lines.push(`... and ${action.cases.length - lines.length} more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Moderator', value: `<@${action.moderatorId}>`, inline: true },
    { name: 'Users', value: String(action.cases.length), inline: true },
  ];
  if (action.reason) {
    fields.push({ name: 'Reason', value: action.reason.slice(0, 1024), inline: false });
  }

  const first = action.cases[0].caseNumber;
  const last = action.cases[action.cases.length - 1].caseNumber;

  return {
    title: `${getActionEmoji(action.actionType)} ${action.actionType.toUpperCase()} (${action.cases.length} users)`,
    description: lines.join('\n'),
    color: getActionColor(action.actionType),
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `Cases #${first}-#${last}` },
  };
}

/**
 * Create an embed for a moderation action
 */
function createModerationEmbed(moderationCase: {
  caseNumber: number;
  actionType: string;
  userId: string;
  moderatorId: string;
  reason?: string;
  duration?: number;
  expiresAt?: string;
}): DiscordEmbed {
  const actionType = moderationCase.actionType.toUpperCase();
  const color = getActionColor(moderationCase.actionType);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'User', value: `<@${moderationCase.userId}>`, inline: true },
    { name: 'Moderator', value: `<@${moderationCase.moderatorId}>`, inline: true },
    { name: 'Case', value: `#${moderationCase.caseNumber}`, inline: true },
  ];

  if (moderationCase.reason) {
    fields.push({ name: 'Reason', value: moderationCase.reason, inline: false });
  }

  if (moderationCase.duration) {
    fields.push({
      name: 'Duration',
      value: formatDuration(moderationCase.duration),
      inline: true,
    });
  }

  if (moderationCase.expiresAt) {
    const timestamp = Math.floor(new Date(moderationCase.expiresAt).getTime() / 1000);
    fields.push({
      name: 'Expires',
      value: `<t:${timestamp}:R>`,
      inline: true,
    });
  }

  return {
    title: `${getActionEmoji(moderationCase.actionType)} ${actionType}`,
    color,
    fields,
    timestamp: new Date().toISOString(),
    footer: {
      text: `Case #${moderationCase.caseNumber}`,
    },
  };
}

/**
 * Get color for action type
 */
function getActionColor(actionType: string): number {
  const type = actionType.toUpperCase();
  return (COLORS as any)[type] || COLORS.INFO;
}

/**
 * Get emoji for action type
 */
function getActionEmoji(actionType: string): string {
  const emojis: Record<string, string> = {
    ban: '🔨',
    unban: '✅',
    kick: '👢',
    timeout: '⏰',
    untimeout: '✅',
    warn: '⚠️',
    mute: '🔇',
    unmute: '🔊',
    purge: '🗑️',
  };

  return emojis[actionType.toLowerCase()] || '📋';
}

/**
 * Format duration in seconds to human-readable string
 */
export function formatDuration(seconds: number): string {
  const units = [
    { name: 'day', seconds: 86400 },
    { name: 'hour', seconds: 3600 },
    { name: 'minute', seconds: 60 },
    { name: 'second', seconds: 1 },
  ];

  const parts: string[] = [];

  for (const unit of units) {
    if (seconds >= unit.seconds) {
      const count = Math.floor(seconds / unit.seconds);
      seconds -= count * unit.seconds;
      parts.push(`${count} ${unit.name}${count !== 1 ? 's' : ''}`);
    }
  }

  return parts.join(', ') || '0 seconds';
}

/**
 * Parse duration string to seconds
 */
export function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)([smhdw])$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };

  return value * (multipliers[unit] || 0);
}

/**
 * Create info embed
 */
export function createInfoEmbed(
  title: string,
  description: string,
  fields?: Array<{ name: string; value: string; inline?: boolean }>
): DiscordEmbed {
  return {
    title,
    description,
    color: COLORS.INFO,
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Append lines to a message without exceeding the embed description limit (4096 characters)
 */
export function appendLimited(message: string, lines: string[], maxLength = 3900): string {
  for (let i = 0; i < lines.length; i++) {
    if (message.length + lines[i].length + 1 > maxLength) {
      return `${message}\n... and ${lines.length - i} more`;
    }
    message += `\n${lines[i]}`;
  }
  return message;
}

/**
 * Create error embed
 */
export function createErrorEmbed(message: string): DiscordEmbed {
  return {
    title: '❌ Error',
    description: message,
    color: 0xff0000,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create success embed
 */
export function createSuccessEmbed(message: string): DiscordEmbed {
  return {
    title: '✅ Success',
    description: message,
    color: 0x00ff00,
    timestamp: new Date().toISOString(),
  };
}
