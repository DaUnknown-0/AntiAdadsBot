# Discord Moderation Bot - Setup Guide

## Overview

This Discord moderation bot runs on Cloudflare Workers (free tier compatible) and provides global ban management across multiple servers.

## New Features

### 1. Hourly Global Ban Enforcement Check

The bot can automatically check every hour if globally banned users are actually banned in servers where global bans are enabled. If a user is found to be unbanned, the bot will enforce the ban.

#### Setup with External Cron Service (Free Plan Compatible)

Since Cloudflare Workers free plan has limitations on scheduled events, you can use a free external cron service to trigger the check:

1. **Get your worker URL**: `https://your-worker.workers.dev`

2. **Set up a cron job** using a service like [cron-job.org](https://cron-job.org) (free):
   - URL: `https://your-worker.workers.dev/scheduled/check-global-bans`
   - Method: `POST`
   - Headers:
     - `Authorization: Bearer YOUR_GLOBAL_BANS_ADMIN_KEY`
     - `Content-Type: application/json`
   - Schedule: Every hour (0 * * * *)

3. **Security**: The endpoint requires your `GLOBAL_BANS_ADMIN_KEY` for authentication.

### 2. Improved Global Mass Ban

The `/globalmassban` command now:
- First adds all users to the global ban database
- Then processes bans across all servers in a loop
- Provides better error handling and reporting
- Works within Cloudflare Workers free tier limits

Usage:
```
/globalmassban users:123456789,987654321 reason:"Spam bots"
```

### 3. Check Ban Status Command

Check if multiple users are banned across all servers with global bans enabled.

Command: `/checkbans`
- **users**: Comma or space separated list of user IDs/mentions
- Permission: Special users only

Example:
```
/checkbans users:123456789,987654321,555666777
```

The bot will:
1. Check ban status for each user across all servers
2. Report which users are not fully banned
3. Provide a command to ban them if needed

### 4. List Global Ban Servers

View all servers where global bans are enabled.

Command: `/listglobalbanservers`
- Permission: Special users only

Shows:
- Server name
- Server ID
- Link to open the server in Discord

### 5. Global Unban Command

Remove a user from the global ban list and automatically unban them from all servers where they were banned by this application.

Command: `/globalunban`
- **user**: The user to globally unban
- **reason**: Reason for the unban (optional)
- Permission: Special users only

Example:
```
/globalunban user:@User reason:"Appeal accepted"
```

The bot will:
1. Remove all records of the user from the global ban database
2. Attempt to unban the user from all servers with global bans enabled
3. Report success/failure for each server

**Important**: This only unbans users that were banned by this application. It will not interfere with manual bans or bans from other systems.

### 6. Announcement Command

Send important notices to log channels in all servers with global bans enabled.

Command: `/announce`
- **title**: Title of the announcement
- **message**: Content of the announcement
- Permission: Special users only

Example:
```
/announce title:"System Maintenance" message:"The global ban system will be updated on Friday."
```

## Command Registration

To register all commands with Discord:

```bash
export DISCORD_APPLICATION_ID="your_application_id"
export DISCORD_BOT_TOKEN="your_bot_token"
node scripts/register-commands.js
```

## Environment Variables

Set these using `npx wrangler secret put <NAME>`:

- `DISCORD_PUBLIC_KEY` - Discord application public key
- `DISCORD_BOT_TOKEN` - Discord bot token
- `DISCORD_APPLICATION_ID` - Discord application ID
- `SPECIAL_USER_IDS` - Comma-separated list of user IDs with special permissions
- `GLOBAL_BANS_ADMIN_KEY` - Admin key for API access and scheduled checks
- `GLOBAL_BANS_READONLY_KEY` - Read-only key for API access (optional)
- `DISABLE_GLOBAL_BAN_WORKER` - Set to "1" to disable global bans on Worker (optional)

## Database Schema

The bot uses Cloudflare D1 database. The `global_bans` table structure:

```sql
CREATE TABLE global_bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  requested_by TEXT,
  reason TEXT,
  delete_messages INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, completed, failed
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

## API Endpoints

### Get Global Bans
```
GET /global-bans
Authorization: Bearer YOUR_READONLY_KEY
Query params: status=pending|completed|failed, limit=50, offset=0
```

### Get Global Ban Users
```
GET /global-bans/users
Authorization: Bearer YOUR_READONLY_KEY
Query params: limit=100, offset=0
```

### Create Global Ban Tasks
```
POST /global-bans
Authorization: Bearer YOUR_ADMIN_KEY
Body: { "user_ids": ["123"], "reason": "...", "delete_messages": 0 }
```

### Scheduled Check Endpoint
```
POST /scheduled/check-global-bans
Authorization: Bearer YOUR_ADMIN_KEY
```

## Deployment

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up database**:
   ```bash
   npx wrangler d1 migrations apply discord-moderation-db
   ```

3. **Set secrets**:
   ```bash
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put SPECIAL_USER_IDS
   npx wrangler secret put GLOBAL_BANS_ADMIN_KEY
   ```

4. **Deploy**:
   ```bash
   npm run deploy
   ```

5. **Register commands**:
   ```bash
   node scripts/register-commands.js
   ```

## Free Tier Considerations

This bot is designed to work within Cloudflare Workers free tier:

- **CPU Time**: Uses `ctx.waitUntil()` for long-running operations
- **Requests**: Rate limiting via Durable Objects
- **Storage**: D1 database (free tier: 5 GB storage, 5 million reads/day)
- **Scheduled Events**: Use external cron service instead of built-in cron triggers

## Support

For issues or questions, check the console logs via:
```bash
npm run tail
```
