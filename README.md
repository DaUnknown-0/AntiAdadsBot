# Discord Moderation Bot

A multi-server Discord moderation bot running on Cloudflare Workers with Durable Objects.

## Features

- 🚀 Serverless architecture on Cloudflare Workers
- � Multi-server support with D1 database
- 📝 Comprehensive moderation logging and case history
- 🔨 Global ban functionality (via local Python bot for long operations)
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

5. Create `.dev.vars` file with your Discord credentials:
```
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_application_id
```

6. Run database migrations:
```bash
npm run db:migrate
```

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
- **ScheduledActions**: Handles timed moderation actions (unbans, unmutes, timeouts)

### Database Schema

- **guild_configs**: Server-specific configuration
- **moderation_cases**: All moderation actions with case numbers
- **user_infractions**: User infraction history
- **scheduled_actions**: Pending timed actions

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

Users exceeding these limits are temporarily blocked for 30 seconds.

## License

MIT
