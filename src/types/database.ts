// Database schema types

export interface GuildConfig {
  guild_id: string;
  mod_log_channel_id?: string;
  mod_role_ids: string; // JSON array of role IDs
  helper_role_ids: string; // JSON array of role IDs
  moderator_role_ids: string; // JSON array of role IDs
  admin_role_ids: string; // JSON array of role IDs
  automod_enabled: boolean;
  automod_spam: boolean;
  automod_caps: boolean;
  automod_invites: boolean;
  automod_mentions: boolean;
  welcome_message?: string;
  welcome_channel_id?: string;
  leave_message?: string;
  leave_channel_id?: string;
  global_bans_enabled?: number;
  command_permissions?: string; // JSON mapping of command -> required PermissionLevel (number)
  created_at: string;
  updated_at: string;
}

export interface ModerationCase {
  id: number;
  guild_id: string;
  case_number: number; // Per-guild case number
  user_id: string;
  moderator_id: string;
  action_type: string; // 'warn', 'timeout', 'kick', 'ban', 'mute'
  reason?: string;
  duration?: number; // Duration in seconds for timed actions
  expires_at?: string; // When the action expires (for unmute/unban)
  active: boolean; // Whether the action is still active
  message_id?: string; // Log message ID
  created_at: string;
}

export interface UserInfraction {
  id: number;
  user_id: string;
  guild_id: string;
  infraction_type: string; // 'warn', 'timeout', 'kick', 'ban', 'mute'
  case_id: number;
  created_at: string;
}

export interface ScheduledAction {
  id: number;
  guild_id: string;
  user_id: string;
  action_type: string; // 'unban', 'unmute', 'untimeout'
  execute_at: string;
  case_id?: number;
  created_at: string;
}

// Permission levels for custom system
export enum PermissionLevel {
  NONE = 0,
  HELPER = 1,
  MODERATOR = 2,
  ADMIN = 3,
  OWNER = 4,
}

export interface CommandPermission {
  command: string;
  required_level: PermissionLevel;
}
