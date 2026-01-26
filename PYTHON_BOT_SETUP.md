# Python Bot Setup - CRITICAL CONFIGURATION

## Problem
Your Discord Application has an **Interaction Endpoint URL** set (pointing to your Cloudflare Worker). This causes Discord to route ALL slash commands via HTTPS to the Worker instead of via Gateway to the Python bot.

## Solution - Remove the Interaction Endpoint URL

### Step 1: Go to Discord Developer Portal
1. Visit: https://discord.com/developers/applications/1459662001482633400/information
2. Navigate to: **General Information** tab

### Step 2: Clear the Interactions Endpoint URL
1. Find the field labeled **"INTERACTIONS ENDPOINT URL"**
2. **DELETE** the entire URL (should be something like `https://discord-moderation-bot.your-subdomain.workers.dev`)
3. Leave it **completely blank**
4. Click **"Save Changes"** at the bottom

### Step 3: Restart the Python Bot
```powershell
py scripts/global_mass_ban.py
```

## What This Does
- **Before**: Discord sends commands → Cloudflare Worker HTTPS endpoint
- **After**: Discord sends commands → Gateway → Python bot (both bots receive commands)

## How Both Bots Will Work Together
Once you clear the endpoint URL:

### Cloudflare Worker (via Gateway)
- Handles: ping, toggleglobalban, setlogchannel
- Fast, edge-deployed, no timeouts for these commands

### Python Bot (via Gateway) 
- Handles: globalban, globalmassban
- Runs locally, no timeout limits, processes hundreds of bans

Both bots will receive commands, but:
- Worker will return "Global bans are disabled" for globalban/globalmassban
- Python bot will only respond to globalban/globalmassban
- Result: Clean separation, no conflicts

## Verify It's Working
After clearing the URL and restarting the bot, you should see:
```
Logged in as general moderation#5592 (ID: 1459662001482633400)
Connected to 4 guilds
------
Synced 2 command(s)
```
And the bot should stay running (not crash).

Then try `/globalmassban` in Discord - it will go to the Python bot!
