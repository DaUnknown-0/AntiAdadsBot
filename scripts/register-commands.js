/**
 * Script to register Discord slash commands
 * Run: node scripts/register-commands.js
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Your bot credentials (set these as environment variables)
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN environment variables');
  process.exit(1);
}

// Define all commands
const commands = [
  { name: 'job-status', description: 'Show a moderation job or the latest job', options: [{ name: 'id', description: 'Job ID (defaults to latest)', type: 3, required: false }] },
  { name: 'cancel-job', description: 'Stop a moderation job after its current batch', options: [{ name: 'id', description: 'Job ID (defaults to latest)', type: 3, required: false }] },
  { name: 'server-health', description: 'Check global-ban settings and bot permissions in this server' },
  {
    name: 'globalban',
    description: 'Globally ban a user across enabled servers',
    options: [
      {
        name: 'user',
        description: 'The user to globally ban',
        type: 6, // USER
        required: true,
      },
      {
        name: 'reason',
        description: 'Reason for the global ban',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'delete_messages',
        description: 'Delete messages from the last X days (0-7)',
        type: 4, // INTEGER
        required: false,
        min_value: 0,
        max_value: 7,
      },
    ],
  },
  {
    name: 'globalmassban',
    description: 'Globally ban multiple users across enabled servers',
    options: [
      {
        name: 'users',
        description: 'Comma or space separated list of user IDs/mentions',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'reason',
        description: 'Reason for the global ban',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'delete_messages',
        description: 'Delete messages from the last X days (0-7)',
        type: 4, // INTEGER
        required: false,
        min_value: 0,
        max_value: 7,
      },
    ],
  },
  {
    name: 'globalunban',
    description: 'Remove a user from global bans and unban from servers',
    options: [
      {
        name: 'user',
        description: 'The user to globally unban',
        type: 6, // USER
        required: true,
      },
      {
        name: 'reason',
        description: 'Reason for the global unban',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'purgeglobalban',
    description: 'Permanently remove a user from global-ban records',
    options: [
      {
        name: 'user',
        description: 'The user to purge from global-ban records',
        type: 6, // USER
        required: true,
      },
    ],
  },
  {
    name: 'toggleglobalban',
    description: 'Toggle global bans for this server (default false)'
  },
  {
    name: 'toggleautoenforce',
    description: 'Toggle hourly automatic re-ban of globally banned users for this server (default false)'
  },
  {
    name: 'setlogchannel',
    description: 'Set or clear the moderation log channel for this server',
    options: [
      {
        name: 'channel',
        description: 'Channel to send moderation logs to',
        type: 7, // CHANNEL
        required: false,
      },
      {
        name: 'clear',
        description: 'Clear the log channel setting',
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  {
    name: 'ping',
    description: 'Check if the bot is online',
  },
  {
    name: 'checkbans',
    description: 'Check ban status of multiple users across servers',
    options: [
      {
        name: 'users',
        description: 'Comma or space separated list of user IDs/mentions to check',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'file',
        description: 'Upload a file with user IDs (one per line or comma-separated)',
        type: 11, // ATTACHMENT
        required: false,
      },
      {
        name: 'server',
        description: 'Optional: Check only in this specific server ID',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'listglobalbanservers',
    description: 'List all servers with global bans enabled',
  },
  {
    name: 'check-servers',
    description: 'Check all bot servers and list those with global bans disabled',
  },
  {
    name: 'announce',
    description: 'Send announcement to log channels in all servers',
    options: [
      {
        name: 'title',
        description: 'Title of the announcement',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'message',
        description: 'Content of the announcement',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'auditglobalbans',
    description: 'Check if all globally banned users are actually banned everywhere',
  },
  {
    name: 'exportglobalbans',
    description: 'Export all globally banned user IDs as a comma-separated list',
  },
];

async function registerCommands() {
  try {
    console.log('Registering commands...');

    const response = await fetch(
      `${DISCORD_API_BASE}/applications/${APPLICATION_ID}/commands`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register commands: ${error}`);
    }

    const data = await response.json();
    console.log(`Successfully registered ${data.length} commands!`);
    console.log('Commands:', data.map(cmd => cmd.name).join(', '));
  } catch (error) {
    console.error('Error registering commands:', error);
    process.exit(1);
  }
}

registerCommands();
