# Discord Moderation Bot - Commands Reference

## Quick Command List

### Global Ban Management (Special Users Only)

#### `/globalban`
Ban a single user across all servers with global bans enabled.
```
/globalban user:@User reason:"Spam" delete_messages:7
```
- **user**: User to ban (required)
- **reason**: Ban reason (optional)
- **delete_messages**: Delete messages from last X days, 0-7 (optional)

#### `/globalmassban`
Ban multiple users at once across all servers.
```
/globalmassban users:123456789,987654321 reason:"Raid bots"
```
- **users**: Comma or space-separated user IDs/mentions (required)
- **reason**: Ban reason (optional)
- **delete_messages**: Delete messages from last X days, 0-7 (optional)

#### `/globalunban`
Remove a user from the global ban list and unban them everywhere.
```
/globalunban user:@User reason:"Appeal accepted"
```
- **user**: User to unban (required)
- **reason**: Unban reason (optional)

#### `/purgeglobalban`
Permanently remove a user from global-ban records so they no longer appear in the ban list or exports.
```
/purgeglobalban user:@User
```
- **user**: User to purge from global-ban records (required)

#### `/checkbans`
Check if users are banned across servers.
```
/checkbans users:123456789,987654321,555666777
/checkbans file:[upload .txt file with user IDs]
/checkbans users:123456789 server:1234567890123456789
```
- **users**: Comma or space-separated user IDs to check (optional)
- **file**: Upload a text file with user IDs (one per line or comma-separated) (optional)
- **server**: Check only in this specific server ID (optional)

Note: Provide either `users` text input OR upload a file, not both.
If `server` is provided, checks only that one server instead of all global-ban-enabled servers.

Returns:
- Ban status for each user across all servers (or single server if specified)
- List of users not fully banned
- **🔨 Button to ban users ONLY in servers where they're not already banned** (special users only)

#### `/listglobalbanservers`
View all servers where global bans are enabled.
```
/listglobalbanservers
```

Returns:
- Server names and IDs
- Links to open each server in Discord

#### `/announce`
Send important announcements to all log channels.
```
/announce title:"Maintenance Notice" message:"System will be down Friday 10pm-12am UTC"
```
- **title**: Announcement title (required)
- **message**: Announcement content (required)

#### `/auditglobalbans`
Audit all globally banned users to ensure they're banned everywhere.
```
/auditglobalbans
```

This command:
- Checks every user in the global ban list
- Reads each server's ban list (one API request per 1000 bans), so the number of banned users does not matter
- Shows which users are missing bans
- Provides a button to enforce bans for all non-compliant users

Returns:
- Total users checked
- Total servers checked
- List of users not fully banned (with ban counts)
- **⚠️ Button to enforce the missing bans** (only where a ban is actually missing)

The check runs in the background in batches, so neither the number of banned users nor the number of
servers is limited. The same check runs every hour (Cron Trigger) and bans automatically, but only in
servers that enabled `/toggleautoenforce`.

### Server Administration (Admin Only)

#### `/toggleglobalban`
Enable or disable global bans for your server.
```
/toggleglobalban
```

Toggles between:
- **Enabled**: Server participates in global bans
- **Disabled**: Server is excluded from global ban system

#### `/toggleautoenforce`
Enable or disable the hourly automatic re-ban for your server (default: disabled).
```
/toggleautoenforce
```

- **Enabled**: Every hour the bot bans users from the global ban list who are not banned here,
  including users a moderator unbanned locally
- **Disabled**: Missing bans are only applied after confirming `/auditglobalbans` or `/checkbans`

Only has an effect while global bans are enabled for the server.

#### `/setlogchannel`
Configure where moderation logs are sent.
```
/setlogchannel channel:#mod-logs
/setlogchannel clear:true
```
- **channel**: Channel for logs (optional)
- **clear**: Remove log channel setting (optional)

### Info Commands (Everyone)

#### `/ping`
Check if the bot is online and responding.
```
/ping
```

## Permission Levels

### Special Users
Users listed in `SPECIAL_USER_IDS` environment variable. Can use:
- `/globalban`
- `/globalmassban`
- `/globalunban`
- `/purgeglobalban`
- `/checkbans`
- `/listglobalbanservers`
- `/announce`
- `/auditglobalbans`

### Admins
Users with Administrator permission or admin roles. Can use:
- `/toggleglobalban`
- `/toggleautoenforce`
- `/setlogchannel`
- All Special User commands

### Everyone
- `/ping`

## Workflow Examples

### Example 1: Ban a Raid
```
1. /globalmassban users:111111111,222222222,333333333 reason:"Raid participants"
2. Bot adds all to database
3. Bot bans across all servers with global bans enabled
4. Results sent with success/failure count
```

### Example 2: Verify Bans (Text Input)
```
1. /checkbans users:111111111,222222222
2. Bot checks ban status across all servers
3. If any aren't banned: "User 111111111: Banned in 5/10 servers"
4. Click the "🔨 Ban X Users" button to ban them all at once
```

### Example 2b: Verify Bans (File Upload)
```
1. Create a file users.txt with:
   111111111
   222222222
   333333333
2. /checkbans file:[upload users.txt]
3. Bot checks ban status across all servers
4. If any aren't banned, click the button to ban them
```

### Example 3: Appeal Process
```
1. User appeals their ban
2. Review and decide to accept
3. /globalunban user:@AppealUser reason:"Appeal accepted - first offense"
4. Bot removes from global ban list
5. Bot unbans from all servers
6. Results sent with success/failure count
```

### Example 4: Check Server Status
```
1. /listglobalbanservers
2. See all servers participating in global bans
3. Click links to visit servers
4. Verify bot is present and configured correctly
```

### Example 5: Send Important Notice
```
1. /announce title:"Policy Update" message:"New guidelines: ..."
2. Bot sends formatted embed to all log channels
3. Results show success/failure per server
4. Failed servers listed with reasons
```

### Example 6: Audit All Global Bans
```
1. /auditglobalbans
2. Bot checks ALL users in global ban database
3. Results: "Found 3 users not fully banned"
4. Shows: User123 - Banned in 8/10 servers
5. Click "⚠️ Enforce Bans for 3 Users" button
6. Bot bans them in all missing servers
7. Results updated with success/failure counts
```

Use this regularly to ensure global bans are properly enforced!

## Rate Limiting and Cloudflare Limits

- **Global bans**: one bulk ban request per server and 200 users (`POST /guilds/{id}/bulk-ban`, needs
  Manage Server); servers without Manage Server automatically get single bans (Ban Members is enough)
- **Large jobs**: processed by the BanJob Durable Object in runs of ~40 subrequests; the original
  message shows progress and is replaced by the result
- **Ban checks**: one request per server and 1000 bans, read page by page across batches
  (no limit on servers; ban lists over 50,000 entries are listed as "Not checked")
- **Discord API**: 429 responses are retried automatically
- **Commands**: Rate limited per user/guild via Durable Objects (special users are exempt)

## Error Handling

Common error messages:

| Error | Meaning | Solution |
|-------|---------|----------|
| "Not authorized" | User not in special users list | Add user ID to `SPECIAL_USER_IDS` |
| "No servers have global bans enabled" | No servers opted in | Use `/toggleglobalban` in servers |
| "No log channel configured" | Log channel not set | Use `/setlogchannel` to set one |
| "Bot not in server" | Bot removed from server | Bot auto-disables global bans for that server |
| "Missing permissions (bot needs Ban Members)" | Bot cannot ban in that server | Grant Ban Members |
| "server(s) without the Manage Server permission" | Info, not an error: bans ran one by one | Optional: grant Manage Server for faster bulk bans |
| "Not banned (already banned, ...)" | User was already banned or outranks the bot | Usually nothing to do |
| "Ban list too long (over 50000 bans)" | Server has an extremely long ban list | Check that server with `/checkbans server:<id>` |

## Best Practices

1. **Before mass banning**: Use `/checkbans` to verify current status
2. **After mass banning**: Check results for failed servers
3. **Regular audits**: Use `/listglobalbanservers` to track participating servers
4. **Log channels**: Set up log channels in all servers before enabling global bans
5. **Appeals**: Document all unbans with proper reasons
6. **Announcements**: Use for important system updates, not routine messages

## API Access

For automated systems, use the REST API:

### Get Global Bans
```bash
curl https://your-worker.workers.dev/global-bans \
  -H "Authorization: Bearer YOUR_READONLY_KEY"
```

### Create Global Ban
```bash
curl -X POST https://your-worker.workers.dev/global-bans \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_ids": ["123456789"], "reason": "Automated ban"}'
```

Accepted task statuses for `POST /global-bans/{id}/result`: `pending`, `processing`, `completed`, `failed`.
A `completed` task adds the user to the global ban list.

### Trigger Scheduled Check
Runs automatically every hour for servers with `/toggleautoenforce` enabled; trigger it manually with:
```bash
curl -X POST https://your-worker.workers.dev/scheduled/check-global-bans \
  -H "Authorization: Bearer YOUR_ADMIN_KEY"
```

## Support

- **View logs**: `npm run tail`
- **Check deployment**: `https://your-worker.workers.dev/ping`
- **Test scheduled check**: Manually trigger via curl command above
- **Command issues**: Re-register commands with `node scripts/register-commands.js`
