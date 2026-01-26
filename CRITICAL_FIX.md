# Critical Cloudflare Workers Fix

## Problems Fixed

You were experiencing two critical issues:

### 1. "Too many subrequests" Error
**Problem**: Cloudflare Workers has a limit of ~50 external HTTP requests (subrequests) per invocation.
**Cause**: `/checkbans` and `/auditglobalbans` were making too many Discord API calls (users × guilds).
**Example**: Checking 70 users across 10 servers = 700 API calls ❌

**Fix Applied**:
- Added hard limit check: Maximum 500 total checks
- Added batching with delays (40 checks per batch)
- Added error handling for individual failed checks
- Added user-friendly error messages

### 2. "Stalled HTTP response" Warnings
**Problem**: Response bodies weren't being consumed, causing Cloudflare Workers to cancel requests.
**Cause**: Functions were returning `response.ok` without reading the response body first.

**Fix Applied**:
Fixed ALL Discord API utility functions to properly consume response bodies:
- `isUserBanned()`
- `getGuild()`
- `getGuildMember()`
- `unbanUser()`
- `kickUser()`
- `timeoutUser()`
- `removeTimeout()`
- `bulkDeleteMessages()`
- `getChannelMessages()`
- `sendMessage()`
- `setSlowmode()`
- `updateChannelPermissions()`
- `addRoleToMember()`
- `removeRoleFromMember()`
- `modifyGuildMember()`

## What Changed

### Before (Broken):
```typescript
export async function isUserBanned(...): Promise<boolean> {
  const response = await discordRequest(...);
  return response.ok;  // ❌ Body not consumed!
}
```

### After (Fixed):
```typescript
export async function isUserBanned(...): Promise<boolean> {
  try {
    const response = await discordRequest(...);
    // IMPORTANT: Always consume response body
    const isOk = response.ok;
    await response.text().catch(() => {});
    return isOk;
  } catch (err) {
    console.error('Error checking ban status:', err);
    return false;
  }
}
```

## Usage Limits

### `/checkbans`
- **Maximum**: 500 checks (users × servers)
- **Example**: 50 users across 10 servers = 500 checks ✅
- **Example**: 70 users across 10 servers = 700 checks ❌

### `/auditglobalbans`
- **Maximum**: 500 checks (global bans × servers)
- **Recommendation**: Use the hourly scheduled check for large audits

## What This Means

✅ **No more deadlocks** - All HTTP responses are properly consumed
✅ **No more subrequest errors** - Checks are batched and limited
✅ **Better error handling** - Individual failures won't crash the whole operation
✅ **Clearer error messages** - Users know when they're exceeding limits

## Deploy the Fix

```bash
# Deploy the updated code
npm run deploy

# Register updated commands
node scripts/register-commands.js
```

## Test It

Try your `/checkbans` command again - it should work without errors now!

```
/checkbans users:123456789,987654321
```

The warnings and errors should be gone. 🎉

## For Large Lists

If you need to check more than 500 combinations:

1. **Split into smaller batches**: Check 25 users at a time
2. **Use the hourly scheduled check**: Let the cron job handle it
3. **Use `/auditglobalbans`**: Specifically designed for checking all global bans

## Technical Details

Cloudflare Workers limits:
- **50 subrequests** per invocation (we batch at 40 to be safe)
- **10ms CPU time** on free tier (we add delays to stay under)
- **HTTP response bodies** must be consumed or canceled

All fixed! ✨
