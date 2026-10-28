import { Env } from '../types/env';
import { GuildConfig, PermissionLevel } from '../types/database';
import { DiscordInteraction, DiscordMember } from '../types/discord';

/**
 * Check if user is a special user
 */
function isSpecialUser(env: Env, userId: string): boolean {
  const raw = env.SPECIAL_USER_IDS || '1157902123888037918';
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

/**
 * Permission system utilities
 * Custom hierarchical permission system where admins always have all permissions
 */

// Command permission requirements
export const COMMAND_PERMISSIONS: Record<string, PermissionLevel> = {
  // Global ban commands (restricted to special IDs / admin override)
  'globalban': PermissionLevel.NONE,
  'globalmassban': PermissionLevel.NONE,
  'globalunban': PermissionLevel.NONE,
  'purgeglobalban': PermissionLevel.NONE,
  'toggleglobalban': PermissionLevel.ADMIN,
  'checkbans': PermissionLevel.NONE,
  'listglobalbanservers': PermissionLevel.NONE,
  'announce': PermissionLevel.NONE,
  'auditglobalbans': PermissionLevel.NONE,

  // Logging and info
  'setlogchannel': PermissionLevel.ADMIN,
  'ping': PermissionLevel.NONE,
};

/**
 * Get user's permission level in a guild
 */
export async function getUserPermissionLevel(
  env: Env,
  guildId: string,
  member: DiscordMember | undefined,
  ownerId: string
): Promise<PermissionLevel> {
  if (!member || !member.user) {
    return PermissionLevel.NONE;
  }

  const userId = member.user.id;

  // Owner always has highest permission
  if (userId === ownerId) {
    return PermissionLevel.OWNER;
  }

  // Check for administrator permission
  if (member.permissions) {
    const permissions = BigInt(member.permissions);
    const ADMINISTRATOR = 1n << 3n;
    
    if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) {
      return PermissionLevel.ADMIN;
    }
  }

  // Get guild config
  const config = await getGuildConfig(env, guildId);
  if (!config) {
    return PermissionLevel.NONE;
  }

  const userRoles = new Set(member.roles);

  // Check admin roles
  const adminRoles = JSON.parse(config.admin_role_ids || '[]') as string[];
  if (adminRoles.some(roleId => userRoles.has(roleId))) {
    return PermissionLevel.ADMIN;
  }

  // Check moderator roles
  const modRoles = JSON.parse(config.moderator_role_ids || '[]') as string[];
  if (modRoles.some(roleId => userRoles.has(roleId))) {
    return PermissionLevel.MODERATOR;
  }

  // Check helper roles
  const helperRoles = JSON.parse(config.helper_role_ids || '[]') as string[];
  if (helperRoles.some(roleId => userRoles.has(roleId))) {
    return PermissionLevel.HELPER;
  }

  return PermissionLevel.NONE;
}

/**
 * Check if user has permission to run a command
 * Admins (level 3+) always have all permissions
 */
export function hasPermission(
  userLevel: PermissionLevel,
  requiredLevel: PermissionLevel
): boolean {
  // Admins and above always have permission
  if (userLevel >= PermissionLevel.ADMIN) {
    return true;
  }

  // Otherwise check if user level meets requirement
  return userLevel >= requiredLevel;
}

/**
 * Check if user can run a specific command
 */
export async function canRunCommand(
  env: Env,
  interaction: DiscordInteraction,
  commandName: string,
  ownerId: string
): Promise<{ allowed: boolean; userLevel: PermissionLevel; requiredLevel: PermissionLevel }> {
  const userId = interaction.member?.user?.id || interaction.user?.id || '';

  // Special users can always run setup commands (setlogchannel, toggleglobalban)
  if (isSpecialUser(env, userId) && (commandName === 'setlogchannel' || commandName === 'toggleglobalban')) {
    return {
      allowed: true,
      userLevel: PermissionLevel.ADMIN,
      requiredLevel: PermissionLevel.ADMIN,
    };
  }

  // Base required level from default map
  let requiredLevel = COMMAND_PERMISSIONS[commandName] || PermissionLevel.NONE;

  if (!interaction.guild_id) {
    // DM commands - only allow info commands
    return {
      allowed: requiredLevel === PermissionLevel.NONE,
      userLevel: PermissionLevel.NONE,
      requiredLevel,
    };
  }

  // Check for per-guild overrides
  try {
    const config = await getGuildConfig(env, interaction.guild_id);
    if (config && config.command_permissions) {
      const mapping = JSON.parse(config.command_permissions || '{}') as Record<string, number | string>;
      if (mapping && mapping[commandName] !== undefined) {
        const val = mapping[commandName];
        // Allow either numeric levels or string names
        if (typeof val === 'number') {
          requiredLevel = Number(val) as PermissionLevel;
        } else if (typeof val === 'string' && (PermissionLevel as any)[val] !== undefined) {
          requiredLevel = (PermissionLevel as any)[val] as PermissionLevel;
        }
      }
    }
  } catch (err) {
    console.error('Error parsing command_permissions for guild:', err);
  }

  const userLevel = await getUserPermissionLevel(
    env,
    interaction.guild_id,
    interaction.member,
    ownerId
  );

  return {
    allowed: hasPermission(userLevel, requiredLevel),
    userLevel,
    requiredLevel,
  };
}

/**
 * Get guild configuration from database
 */
export async function getGuildConfig(env: Env, guildId: string): Promise<GuildConfig | null> {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM guild_configs WHERE guild_id = ?'
    ).bind(guildId).first<GuildConfig>();

    return result;
  } catch (error) {
    console.error('Error fetching guild config:', error);
    return null;
  }
}

/**
 * Get or create guild configuration
 */
export async function getOrCreateGuildConfig(env: Env, guildId: string): Promise<GuildConfig> {
  let config = await getGuildConfig(env, guildId);

  if (!config) {
    // Create default config
    await env.DB.prepare(
      'INSERT INTO guild_configs (guild_id) VALUES (?)'
    ).bind(guildId).run();

    config = await getGuildConfig(env, guildId);
    if (!config) {
      throw new Error('Failed to create guild config');
    }
  }

  return config;
}

/**
 * Update guild configuration
 */
export async function updateGuildConfig(
  env: Env,
  guildId: string,
  updates: Partial<GuildConfig>
): Promise<void> {
  // Ensure guild config exists first
  await getOrCreateGuildConfig(env, guildId);

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key !== 'guild_id' && key !== 'created_at') {
      fields.push(`${key} = ?`);
      values.push(value === undefined ? null : value);
    }
  }

  if (fields.length === 0) {
    return;
  }

  fields.push('updated_at = datetime("now")');
  values.push(guildId);

  const query = `UPDATE guild_configs SET ${fields.join(', ')} WHERE guild_id = ?`;
  
  try {
    await env.DB.prepare(query).bind(...values).run();
  } catch (error) {
    console.error('Error updating guild config:', error);
    throw error;
  }
}

/**
 * Get permission level name
 */
export function getPermissionLevelName(level: PermissionLevel): string {
  switch (level) {
    case PermissionLevel.NONE:
      return 'None';
    case PermissionLevel.HELPER:
      return 'Helper';
    case PermissionLevel.MODERATOR:
      return 'Moderator';
    case PermissionLevel.ADMIN:
      return 'Admin';
    case PermissionLevel.OWNER:
      return 'Owner';
    default:
      return 'Unknown';
  }
}
