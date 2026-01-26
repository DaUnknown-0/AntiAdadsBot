# Interactive Button Feature for `/checkbans`

## Overview

The `/checkbans` command now includes an interactive button that allows special users to ban all users who aren't fully banned across servers - with a single click!

## How It Works

### 1. User Runs Check
```
/checkbans users:123456789,987654321
```
or
```
/checkbans file:[upload users.txt]
```

### 2. Bot Analyzes Ban Status

The bot checks each user across all servers with global bans enabled and reports:
- Total users checked
- Total servers checked
- Which users are not fully banned
- How many servers each user is missing from

### 3. Interactive Button Appears

If any users are not fully banned, the bot displays:
```
⚠️ Users not fully banned:
• @User1 (123456789): Banned in 5/10 servers
• @User2 (987654321): Banned in 3/10 servers

🔨 [Ban 2 Users] <- Click this button!
```

### 4. Click to Ban

When you click the button:
1. **Instant feedback**: Message updates to "🔄 Processing global bans..."
2. **Background processing**: Bot bans all users from all servers where they're missing
3. **Final update**: Message shows detailed results with success/failure counts

## Technical Details

### Security Features

✅ **Permission Check**: Only special users can click the button
✅ **One-time Use**: Button is removed after clicking (prevents double-execution)
✅ **Expiration**: Pending actions expire after 1 hour
✅ **Requester Verification**: Only the user who ran the check (or other special users) can click

### Database Storage

The button uses a temporary database table:
```sql
CREATE TABLE pending_ban_actions (
  id TEXT PRIMARY KEY,           -- UUID for the button
  user_ids TEXT NOT NULL,        -- JSON array of users to ban
  reason TEXT,
  delete_messages INTEGER,
  requested_by TEXT NOT NULL,    -- Who initiated the check
  expires_at TEXT                -- Auto-expire after 1 hour
);
```

### Rate Limiting

The button-triggered ban follows the same rate limiting as `/globalmassban`:
- 1.5 second delay between each ban
- Prevents Discord API rate limit errors
- Safe for large lists (70+ users)

## File Upload Feature

### Supported Formats

**Option 1: One user per line**
```
123456789
987654321
555666777
```

**Option 2: Comma-separated**
```
123456789,987654321,555666777
```

**Option 3: Mixed (spaces, commas, newlines)**
```
123456789, 987654321
555666777
888999000, 111222333
```

### File Requirements
- **Type**: Plain text (.txt recommended)
- **Size**: Reasonable (Discord has upload limits)
- **Encoding**: UTF-8
- **Content**: User IDs (mentions like <@123> are automatically cleaned)

## Example Workflows

### Workflow 1: Small List via Text
```
1. /checkbans users:111,222,333
2. Bot shows: "User 111: Banned in 2/5 servers"
3. Click 🔨 Ban 1 User button
4. Bot processes and updates message with results
```

### Workflow 2: Large List via File
```
1. Create users.txt with 70 user IDs
2. /checkbans file:[upload users.txt]
3. Wait for check to complete (~1-2 minutes)
4. See which users need banning
5. Click 🔨 Ban X Users button
6. Wait for bans to process (~5-10 minutes for 70 users)
7. Review final results
```

### Workflow 3: Verification After Mass Ban
```
1. Run /globalmassban users:111,222,333
2. Later, verify with /checkbans users:111,222,333
3. If any failed, use button to re-attempt
```

## Error Handling

### "This action has expired or does not exist"
- The button data expired (>1 hour old)
- Solution: Run `/checkbans` again to get a fresh button

### "Only the user who initiated the check can execute"
- Someone else tried to click your button
- Solution: Only the original requester or special users can click

### "You are not authorized to use this button"
- User is not in SPECIAL_USER_IDS
- Solution: Ask an admin to add you to the special users list

### Button disappeared after clicking
- This is normal - prevents double execution
- The message will update with results

## Performance

### Checkbans Speed
- **5 servers, 10 users**: ~5 seconds
- **10 servers, 50 users**: ~30 seconds
- **20 servers, 70 users**: ~2 minutes

### Button Ban Speed
- **5 servers, 10 users**: ~1 minute
- **10 servers, 50 users**: ~8 minutes
- **20 servers, 70 users**: ~15 minutes

The ban process uses `ctx.waitUntil()` so it won't timeout, but Discord might show a "thinking" state for a few seconds before updating.

## Advantages Over Manual Commands

**Before** (manual):
```
1. /checkbans users:111,222,333
2. Read results
3. Copy user IDs that need banning
4. Type /globalmassban users:111,222
5. Wait for results
```

**After** (button):
```
1. /checkbans users:111,222,333
2. Click button
3. Done!
```

**Benefits**:
- ✅ No copying/pasting user IDs
- ✅ No typing errors
- ✅ Faster workflow
- ✅ Automatic database integration
- ✅ Better UX for non-technical users

## Limitations

### Discord Button Limits
- Buttons must be clicked within 15 minutes of message posting (Discord interaction token expiry)
- Button data expires after 1 hour (database cleanup)

### Cloudflare Workers Limits
- Each button click processes in background (no timeout issues)
- Uses same rate limiting as other commands
- Free tier compatible

## Troubleshooting

### Button not appearing
- Check if any users actually need banning
- Verify bot has checked at least one server
- If all users are banned, no button appears (this is correct)

### Button click does nothing
- Check browser console for errors
- Try refreshing Discord
- Re-run `/checkbans` if >15 minutes have passed

### Message not updating after click
- Wait longer - bans take time (1.5s per user per server)
- Check `npm run tail` for logs
- Verify worker is running: `https://your-worker.workers.dev/ping`

## Migration Required

Before using the button feature, run:
```bash
npx wrangler d1 migrations apply discord-moderation-db
```

This creates the `pending_ban_actions` table needed for button functionality.

## Security Considerations

✅ **No command injection**: User IDs are validated
✅ **No data leaks**: Pending actions are private
✅ **Rate limit safe**: Uses same delays as manual commands
✅ **Permission controlled**: Only special users can use
✅ **Audit trail**: All bans logged to database

---

**Enjoy the new interactive button feature!** 🎉
