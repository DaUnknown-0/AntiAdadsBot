#!/bin/bash
# Script to check current database state

echo "=== Checking guild_configs table schema ==="
npx wrangler d1 execute discord-moderation-db --command="PRAGMA table_info(guild_configs);"

echo ""
echo "=== Checking existing guild configs ==="
npx wrangler d1 execute discord-moderation-db --command="SELECT * FROM guild_configs;"

echo ""
echo "=== Checking if migrations table exists ==="
npx wrangler d1 execute discord-moderation-db --command="SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations';"

echo ""
echo "=== Checking applied migrations ==="
npx wrangler d1 execute discord-moderation-db --command="SELECT * FROM d1_migrations;" 2>/dev/null || echo "d1_migrations table doesn't exist"
