# Discord Moderation Bot

A multi-server Discord moderation bot running on Cloudflare Workers with Durable Objects.

## Features

- 🚀 Serverless architecture on Cloudflare Workers
- � Multi-server support with D1 database
- 📝 Comprehensive moderation logging and case history
- 🔨 Global bans across servers: bulk bans (200 users per request) processed by a Durable Object in batches
- ⏰ Hourly global ban enforcement via a native Cron Trigger
- ✅ `/ping` command for quick health checks

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Discord application

### Installation

1. Install dependencies:
```bash
npm install
```

2. Create D1 database:
```bash
npx wrangler d1 create discord-moderation-db
```

3. Create KV namespace:
```bash
npx wrangler kv:namespace create CACHE
```

4. Update `wrangler.toml` with the database ID and KV namespace ID from the previous commands.

5. Store your Discord credentials as Worker secrets (`npx wrangler secret put DISCORD_BOT_TOKEN`, same for the others).
   For local development create a `.dev.vars` file (gitignored):
```
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_application_id
```

6. Run database migrations:
```bash
npm run db:migrate
```

7. Give the bot **Ban Members** and **Manage Server** in every server: the bulk ban endpoint requires both.

### Development

Run the development server:
```bash
npm run dev
```

### Deployment

Deploy to Cloudflare Workers:
```bash
npm run deploy
```

## Architecture

### Durable Objects

- **RateLimiter**: Per-user rate limiting with sliding window algorithm
- **BanJob**: Runs ban, unban and announcement jobs across many servers. Each alarm run is a fresh
  invocation with its own subrequest budget (50 on the free plan), so large jobs finish completely.

### Database Schema

- **guild_configs**: Server-specific configuration
- **moderation_cases**: All moderation actions with case numbers
- **user_infractions**: User infraction history
- **global_ban_list**: One row per globally banned user (source of truth for audits and exports)
- **global_bans**: Task table behind the `/global-bans` HTTP API
- **pending_ban_actions**: Confirmation buttons of `/checkbans` and `/auditglobalbans` (1 hour)

### Permission System

Custom hierarchical permission system:
- **Helper** (Level 1): Basic moderation commands
- **Moderator** (Level 2): Full moderation capabilities
- **Admin** (Level 3): All permissions including configuration
- **Owner** (Level 4): Guild owner

Admins always have access to all commands regardless of specific command permissions.

## Commands

(Implementation in progress - see plan for full command list)

## Rate Limiting

The bot implements a two-tier rate limiting system:
- Short window: 5 commands per 10 seconds
- Long window: 30 commands per minute

Users exceeding these limits are temporarily blocked for 30 seconds. Special users skip the check.

## License

MIT
