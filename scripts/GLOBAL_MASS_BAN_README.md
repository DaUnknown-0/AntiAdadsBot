# Discord Moderation Bot - Python Version

This is a standalone Discord bot that runs locally on your PC. It handles long-running global ban operations that would timeout in Cloudflare Workers.

## Installation

```powershell
pip install discord.py
```

## Setup

1. Set your Discord bot token as an environment variable:

```powershell
$env:DISCORD_BOT_TOKEN = "your-bot-token-here"
```

2. Make sure you're logged in to Wrangler (for D1 database access):

```powershell
npx wrangler login
```

## Running the Bot

```powershell
python scripts/global_mass_ban.py
```

The bot will:
- Start up and connect to Discord
- Register slash commands
- Run continuously until you press Ctrl+C

## Available Commands

### `/globalmassban`
Ban multiple users across all guilds with global bans enabled.

**Parameters:**
- `users` (required) - Space or comma separated user IDs (can use mentions)
- `reason` (optional) - Reason for the ban
- `delete_messages` (optional) - Days of messages to delete (0-7)

**Example:**
```
/globalmassban users:123456789 987654321 reason:Coordinated spam delete_messages:7
```

### `/globalban`
Ban a single user across all guilds with global bans enabled.

**Parameters:**
- `user` (required) - User ID or mention
- `reason` (optional) - Reason for the ban
- `delete_messages` (optional) - Days of messages to delete (0-7)

**Example:**
```
/globalban user:123456789 reason:Spam delete_messages:7
```

## Features

- ✅ No timeout issues - runs locally on your PC
- ✅ Progress updates sent via Discord messages
- ✅ Automatic rate limit handling with retry logic
- ✅ 1.5s delay between bans to respect Discord's 5 bans/5s limit
- ✅ Queries D1 database for guilds with global bans enabled
- ✅ Discord.py native ban methods (no raw API calls)
- ✅ Slash commands with proper parameter validation
- ✅ Only accessible to user ID: 1157902123888037918

## Notes

- The bot must be invited to all guilds where you want to perform global bans
- The bot needs BAN_MEMBERS permission in each guild
- For very large operations (100+ users × multiple guilds), expect long execution times
- The bot will send status updates during processing
- Commands are deferred automatically so Discord doesn't timeout

## Permissions Required

Bot needs these intents:
- `guilds` - To access guild information
- `members` - To access member information (optional but recommended)
- `message_content` - For bot functionality

Bot OAuth2 URL should include:
- `bot` scope
- `applications.commands` scope
- `BAN_MEMBERS` permission
