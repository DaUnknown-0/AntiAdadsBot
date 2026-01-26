# Database Recovery Guide

## Step 1: Check Current State

Run this to see what columns you currently have:

```bash
npx wrangler d1 execute discord-moderation-db --command="PRAGMA table_info(guild_configs);"
```

## Step 2: Check Your Data

See if your guild configs are still there:

```bash
npx wrangler d1 execute discord-moderation-db --command="SELECT * FROM guild_configs;"
```

## Step 3: Recovery Options

### Option A: Data Still Exists (Likely)

If Step 2 shows your `guild_id` and `global_bans_enabled` values, your data is safe! Just run the fix migration:

```bash
npx wrangler d1 execute discord-moderation-db --file=migrations/0003_fix_guild_configs.sql
```

This will:
- ✅ Preserve your `guild_id` values
- ✅ Preserve your `global_bans_enabled` settings
- ✅ Add back all missing columns (`updated_at`, etc.)
- ✅ No data loss

### Option B: Start Fresh (If No Important Data)

If you just set up the bot and don't have important guild configurations:

```bash
# Delete local database
rm -rf .wrangler/state/v3/d1

# Re-run migrations from scratch
npx wrangler d1 migrations apply discord-moderation-db --local
```

### Option C: Manual Recovery (Advanced)

If you want to be extra careful:

1. **Export current data:**
```bash
npx wrangler d1 execute discord-moderation-db --command="SELECT guild_id, global_bans_enabled FROM guild_configs;" > backup.txt
```

2. **Run fix migration:**
```bash
npx wrangler d1 execute discord-moderation-db --file=migrations/0003_fix_guild_configs.sql
```

3. **Verify it worked:**
```bash
npx wrangler d1 execute discord-moderation-db --command="SELECT * FROM guild_configs;"
```

## Step 4: Deploy & Test

```bash
# Deploy updated code
npm run deploy

# Test the command in Discord
/toggleglobalban
```

## What the Fix Does

The `0003_fix_guild_configs.sql` migration:

1. Creates a new table with the complete schema (all 19 columns)
2. Copies your existing data (`guild_id`, `global_bans_enabled`, etc.)
3. Fills missing columns with defaults
4. Replaces the old table

**Your guild configurations will be preserved!**

## Quick Script (Windows)

I've created a script to check your database state:

```bash
check_database.bat
```

This will show you:
- Current table structure
- Existing data
- Applied migrations

## Need Help?

If you see errors or unexpected results, paste the output here and I'll help you fix it!
