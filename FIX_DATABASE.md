# Database Schema Fix

## Problem

The `guild_configs` table is missing the `updated_at` column due to a migration issue. This causes errors when toggling global bans.

## Quick Fix (Recommended for Development)

Since this appears to be a development environment, the easiest fix is to reset the database:

### Option 1: Reset Local Database (If using --local)

```bash
# 1. Delete local database
rm -rf .wrangler/state

# 2. Re-run migrations
npx wrangler d1 migrations apply discord-moderation-db --local
```

### Option 2: Reset Remote Database

⚠️ **WARNING: This will delete all data!**

```bash
# 1. Delete and recreate the database
npx wrangler d1 delete discord-moderation-db
npx wrangler d1 create discord-moderation-db

# 2. Update the database_id in wrangler.toml with the new ID

# 3. Run migrations
npx wrangler d1 migrations apply discord-moderation-db
```

### Option 3: Manual Fix (Preserves Data)

If you have important data and can't reset:

```bash
# Run the fix migration
npx wrangler d1 execute discord-moderation-db --file=migrations/0003_fix_guild_configs.sql

# Or for remote:
npx wrangler d1 execute discord-moderation-db --remote --file=migrations/0003_fix_guild_configs.sql
```

## Verify Fix

After applying the fix, test the command:

```
/toggleglobalban
```

It should work without errors.

## What Happened?

The original `0002_add_global_bans.sql` migration was dropping columns from the `guild_configs` table. This has been fixed, but your database already has the broken schema.

The new migration files are now properly ordered:
- ✅ `0001_initial_schema.sql` - Creates base tables
- ✅ `0002_add_global_bans.sql` - Adds global bans (FIXED - preserves all columns)
- ✅ `0003_fix_guild_configs.sql` - Fixes broken databases (NEW)
- ✅ `0004_add_pending_actions.sql` - Adds button support

## After Fixing

Deploy the updated code:

```bash
npm run deploy
```

Then test all commands to ensure everything works!
