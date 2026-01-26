# Discord Moderation Bot - Setup Guide

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" tab and create a bot
4. Copy the bot token
5. Go to "General Information" and copy:
   - Application ID
   - Public Key

### 3. Configure Environment Variables

Create a `.dev.vars` file (for local development):

```env
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_application_id
```

For production, set these as secrets in Cloudflare:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
```

### 4. Create Database

```bash
# Create D1 database
npx wrangler d1 create discord-moderation-db

# Create KV namespace
npx wrangler kv:namespace create CACHE

# Update wrangler.toml with the IDs from the commands above
```

### 5. Run Migrations

```bash
# For local development
npm run db:local

# For production
npm run db:migrate
```

### 6. Register Discord Commands

```bash
node scripts/register-commands.js
```

### 7. Deploy Worker

```bash
# For local development
npm run dev

# For production
npm run deploy
```

### 8. Configure Discord Interactions URL

1. Deploy your worker (or use ngrok for local dev)
2. Go to Discord Developer Portal > Your App > General Information
3. Set "Interactions Endpoint URL" to your worker URL (e.g., `https://discord-moderation-bot.your-subdomain.workers.dev`)
4. Discord will verify the endpoint

### 9. Invite Bot to Server

Generate an invite URL with these permissions:
- Scope: `bot` + `applications.commands`
- Permissions: `Administrator` (or specific permissions: Ban Members, Kick Members, Moderate Members, Manage Messages, etc.)

Invite URL format:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=8&scope=bot%20applications.commands
```

## Configuration

### Setting Up Moderation Roles

Use the `/setup` command (to be implemented) or directly configure in the database:

```sql
UPDATE guild_configs 
SET 
  admin_role_ids = '["role_id_1", "role_id_2"]',
  moderator_role_ids = '["role_id_3"]',
  helper_role_ids = '["role_id_4"]'
WHERE guild_id = 'your_guild_id';
```

### Setting Up Mod Log Channel

```sql
UPDATE guild_configs 
SET mod_log_channel_id = 'channel_id'
WHERE guild_id = 'your_guild_id';
```

## Features

### Rate Limiting
- 5 commands per 10 seconds per user
- 30 commands per minute per user
- 30-second block on exceeding limits

### Permission System
- **Helper** (Level 1): Warn, Slowmode
- **Moderator** (Level 2): Kick, Timeout, Mute, Purge, Case management
- **Admin** (Level 3): Ban, Lockdown, Configuration, ALL permissions
- **Owner** (Level 4): Guild owner

Admins automatically have access to all commands.

### Implemented Commands

**Moderation:**
- `/globalban` - Globally ban a user across servers with global bans enabled
- `/globalmassban` - Globally ban multiple users across servers with global bans enabled
- `/toggleglobalban` - Toggle global bans for this server
- `/setlogchannel` - Set or clear the moderation log channel for this server

**Information:**
- `/ping` - Check bot status

### Scheduled Actions

Durable Objects handle timed actions:
- Automatic unbans after duration expires
- Automatic unmutes (when implemented)
- Automatic timeout removals

## Development

### Local Development

```bash
# Run dev server
npm run dev

# View logs
npm run tail

# Run migrations locally
npm run db:local
```

### Project Structure

```
src/
├── index.ts                 # Main worker entry point
├── types/                   # TypeScript types
│   ├── env.ts
│   ├── discord.ts
│   └── database.ts
├── durable-objects/         # Durable Objects
│   ├── RateLimiter.ts
│   └── ScheduledActions.ts
├── commands/                # Command handlers
│   ├── index.ts
│   ├── moderation/
│   └── info/
└── utils/                   # Utility functions
    ├── discord.ts
    ├── database.ts
    ├── permissions.ts
    ├── logging.ts
    └── responses.ts
```

## Troubleshooting

### Commands not showing up
- Make sure you ran `register-commands.js`
- Check bot has `applications.commands` scope
- Wait a few minutes for Discord to propagate changes

### Rate limit errors
- Rate limits are per-user per-guild
- Check Durable Object logs
- Increase limits in `RateLimiter.ts` if needed

### Database errors
- Ensure migrations were run
- Check D1 binding in `wrangler.toml`
- Verify database ID is correct

## TODO

Additional commands to implement:
- Configuration commands (setup, setlogchannel, etc.)
- Auto-moderation features
- Additional info commands (serverinfo, roles, etc.)
- Mute/unmute with custom role
- Lockdown/unlock channels
- Slowmode command
- Nickname management

## License

MIT
