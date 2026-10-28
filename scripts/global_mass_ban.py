"""
Discord Moderation Bot - Python Version
Runs locally on your PC to avoid Cloudflare Workers timeout issues.
Supports global ban commands that can take hours to complete.
"""

import os
import sys
import asyncio
import subprocess
from typing import List, Optional, Tuple

import discord
from discord import app_commands
from discord.ext import commands

# ============================================================================
# CONFIGURATION
# ============================================================================

DISCORD_BOT_TOKEN = os.environ.get('DISCORD_BOT_TOKEN', 'REDACTED_TOKEN')
DATABASE_ID = 'discord-moderation-db'

# Hardcoded special user ID (bot owner)
SPECIAL_USER_IDS = {1157902123888037918}

# Rate limiting: Discord allows ~5 bans per 5 seconds per guild
DELAY_BETWEEN_BANS = 1.5  # seconds
MAX_BAN_RETRIES = 3

# Initialize bot
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.members = True

bot = commands.Bot(command_prefix='!', intents=intents)


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def is_special_user(user_id: int) -> bool:
    """Check if a user has special permissions for global commands."""
    return user_id in SPECIAL_USER_IDS


def parse_user_ids(users_string: str) -> List[int]:
    """Parse a string of user IDs (space or comma separated, with or without mentions)."""
    import re
    # Remove mention formatting <@!123> or <@123> and extract numbers
    ids = re.findall(r'\d+', users_string)
    return [int(uid) for uid in ids if uid]


async def get_valid_guild(guild_id: int) -> Optional[discord.Guild]:
    """Get a guild object and validate it has ban capabilities."""
    try:
        guild = bot.get_guild(int(guild_id))
        if not guild:
            guild = await bot.fetch_guild(int(guild_id))
        
        if guild and hasattr(guild, 'ban'):
            return guild
        
        print(f"⚠ Invalid guild object for ID {guild_id}")
        return None
    except Exception as e:
        print(f"⚠ Failed to fetch guild {guild_id}: {e}")
        return None


async def ban_user_with_retry(
    guild: discord.Guild,
    user_id: int,
    reason: str,
    delete_message_days: int
) -> Tuple[bool, str]:
    """
    Ban a single user with automatic retry on rate limits.
    
    Returns:
        (success, message) tuple
    """
    # Check if already banned
    try:
        await guild.fetch_ban(user_id)
        return False, 'already_banned'
    except discord.NotFound:
        pass
    except discord.Forbidden:
        return False, 'no_permission_to_check'
    except Exception:
        pass  # Continue to ban attempt

    # Try banning with retry logic
    attempts = 0
    while attempts < MAX_BAN_RETRIES:
        attempts += 1
        try:
            await guild.ban(
                discord.Object(id=user_id),
                reason=reason,
                delete_message_days=delete_message_days
            )
            return True, 'success'
        
        except discord.Forbidden as e:
            return False, f'forbidden: {e}'
        
        except discord.HTTPException as e:
            if getattr(e, 'status', None) == 429:
                # Rate limited - wait and retry
                retry_after = getattr(e, 'retry_after', None) or (2 ** attempts)
                try:
                    retry_after = float(retry_after)
                except Exception:
                    retry_after = 2 ** attempts
                
                print(f"  ⚠ Rate limited (attempt {attempts}/{MAX_BAN_RETRIES}), waiting {retry_after:.1f}s...")
                await asyncio.sleep(retry_after)
                continue
            else:
                return False, f'http_{e.status}: {e}'
        
        except Exception as e:
            return False, f'error: {e}'
    
    return False, f'gave_up_after_{MAX_BAN_RETRIES}_retries'


async def get_guilds_with_global_bans() -> List[int]:
    """Query D1 database for guilds with global bans enabled."""
    try:
        result = subprocess.run(
            'npx wrangler d1 execute discord-moderation-db --remote --command "SELECT guild_id FROM guild_configs WHERE global_bans_enabled = 1"',
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            check=True,
            shell=True
        )
        
        output = result.stdout
        if not output:
            print("⚠ No output from database query, using all connected guilds")
            return [guild.id for guild in bot.guilds]
        
        guild_ids = []
        for line in output.split('\n'):
            line = line.strip()
            if line and line.startswith('│') and '│' in line[1:]:
                parts = [p.strip() for p in line.split('│') if p.strip()]
                if parts and parts[0] != 'guild_id':
                    try:
                        guild_ids.append(int(parts[0]))
                    except ValueError:
                        pass
        
        if guild_ids:
            print(f"✓ Found {len(guild_ids)} guilds with global bans enabled")
        else:
            print("⚠ No guilds in database, using all connected guilds")
            guild_ids = [guild.id for guild in bot.guilds]
        
        return guild_ids
    
    except subprocess.CalledProcessError as e:
        print(f"⚠ Database query failed: {e.stderr if e.stderr else 'Unknown error'}")
        return [guild.id for guild in bot.guilds]
    except Exception as e:
        print(f"⚠ Unexpected error: {e}")
        return [guild.id for guild in bot.guilds]


# ============================================================================
# BOT EVENTS
# ============================================================================

@bot.event
async def on_ready():
    """Called when bot is ready."""
    print(f'✓ Logged in as {bot.user} (ID: {bot.user.id})')
    print(f'✓ Connected to {len(bot.guilds)} guild(s)')
    print('─' * 60)
    
    try:
        synced = await bot.tree.sync()
        print(f'✓ Synced {len(synced)} command(s)')
    except Exception as e:
        print(f'✗ Failed to sync commands: {e}')


# ============================================================================
# COMMANDS
# ============================================================================

@bot.tree.command(
    name='localmassban',
    description='Ban multiple users across all guilds with global bans enabled (special users only)'
)
@app_commands.describe(
    users='Space or comma separated user IDs or mentions',
    reason='Reason for the ban',
    delete_messages='Days of messages to delete (0-7)'
)
async def localmassban(
    interaction: discord.Interaction,
    users: str,
    reason: Optional[str] = 'No reason provided',
    delete_messages: Optional[int] = 0
):
    """Global mass ban command - bans users across multiple guilds."""
    # Permission check
    if not is_special_user(interaction.user.id):
        await interaction.response.send_message(
            '❌ You are not authorized to use this command.',
            ephemeral=True
        )
        return
    
    # Parse and validate user IDs
    user_ids = parse_user_ids(users)
    if not user_ids:
        await interaction.response.send_message(
            '❌ Please specify at least one valid user ID.',
            ephemeral=True
        )
        return
    
    # Defer response (ephemeral - only visible to the user)
    await interaction.response.defer(ephemeral=True)
    
    # Get guilds with global bans enabled
    guild_ids = await get_guilds_with_global_bans()
    if not guild_ids:
        await interaction.followup.send('❌ No guilds found with global bans enabled.', ephemeral=True)
        return
    
    # Calculate totals
    total_ops = len(user_ids) * len(guild_ids)
    delete_message_days = min(delete_messages, 7)
    
    print(f"\n{'=' * 60}")
    print(f"GLOBAL MASS BAN STARTED")
    print(f"Users: {len(user_ids)} | Guilds: {len(guild_ids)} | Total ops: {total_ops}")
    print(f"{'=' * 60}\n")
    
    await interaction.followup.send(
        f'🔨 Starting global mass ban...\n'
        f'• Users: {len(user_ids)}\n'
        f'• Guilds: {len(guild_ids)}\n'
        f'• Total operations: {total_ops}\n'
        f'• Estimated time: {total_ops * DELAY_BETWEEN_BANS / 60:.1f} minutes',
        ephemeral=True
    )
    
    # Process bans
    results = {'success': 0, 'failed': 0, 'skipped': 0}
    current_op = 0
    
    for user_id in user_ids:
        print(f"\n--- Processing user {user_id} ---")
        
        for guild_id in guild_ids:
            current_op += 1
            progress = (current_op / total_ops) * 100
            print(f"[{progress:.1f}%] Guild {guild_id}... ", end='', flush=True)
            
            # Get and validate guild
            guild = await get_valid_guild(guild_id)
            if not guild:
                print("✗ Invalid guild")
                results['failed'] += 1
                await asyncio.sleep(DELAY_BETWEEN_BANS)
                continue
            
            # Ban the user
            success, msg = await ban_user_with_retry(
                guild, user_id, reason, delete_message_days
            )
            
            if success:
                print("✓ Success")
                results['success'] += 1
            elif msg == 'already_banned':
                print("⊘ Already banned")
                results['skipped'] += 1
            else:
                print(f"✗ {msg}")
                results['failed'] += 1
            
            await asyncio.sleep(DELAY_BETWEEN_BANS)
    
    # Send completion message
    print(f"\n{'=' * 60}")
    print(f"GLOBAL MASS BAN COMPLETED")
    print(f"Success: {results['success']} | Failed: {results['failed']} | Skipped: {results['skipped']}")
    print(f"{'=' * 60}\n")
    
    await interaction.followup.send(
        f'✅ Global mass ban complete!\n'
        f'• Successful: {results["success"]}\n'
        f'• Failed: {results["failed"]}\n'
        f'• Skipped: {results["skipped"]}',
        ephemeral=True
    )


@bot.tree.command(
    name='servermassban',
    description='Ban multiple users in this server only'
)
@app_commands.describe(
    users='Comma or space separated list of user IDs or mentions',
    reason='Reason for the ban',
    delete_messages='Days of messages to delete (0-7)'
)
async def servermassban(
    interaction: discord.Interaction,
    users: str,
    reason: Optional[str] = 'No reason provided',
    delete_messages: Optional[int] = 0
):
    """Server-local mass ban - bans users in the current guild only."""
    # Permission check
    member = interaction.user
    has_permission = (
        getattr(member, 'guild_permissions', None) and 
        member.guild_permissions.ban_members
    ) or is_special_user(member.id)
    
    if not has_permission:
        await interaction.response.send_message(
            '❌ You do not have permission to run this command.',
            ephemeral=True
        )
        return

    # Parse and validate user IDs
    raw_ids = parse_user_ids(users)
    if not raw_ids:
        await interaction.response.send_message(
            '❌ Please specify at least one user ID.',
            ephemeral=True
        )
        return

    valid_user_ids = []
    invalid_inputs = []
    for r in raw_ids:
        try:
            valid_user_ids.append(int(r))
        except Exception:
            invalid_inputs.append(r)

    if not valid_user_ids:
        await interaction.response.send_message(
            '❌ No valid user IDs provided.',
            ephemeral=True
        )
        return

    # Defer response (ephemeral - only visible to the user)
    await interaction.response.defer(ephemeral=True)

    # Get guild
    guild_id = interaction.guild_id
    if not guild_id:
        await interaction.followup.send('❌ This command must be run in a server.', ephemeral=True)
        return

    guild = await get_valid_guild(guild_id)
    if not guild:
        await interaction.followup.send('❌ Could not access guild.', ephemeral=True)
        return

    delete_message_days = min(delete_messages, 7)
    total_ops = len(valid_user_ids)
    
    print(f"\n{'=' * 60}")
    print(f"SERVER MASS BAN STARTED")
    print(f"Guild: {guild.name} ({guild_id}) | Users: {total_ops}")
    print(f"{'=' * 60}\n")
    
    await interaction.followup.send(
        f'🔨 Starting server mass ban...\n'
        f'• Users: {len(valid_user_ids)}',
        ephemeral=True
    )

    results = {'success': 0, 'failed': 0, 'skipped': 0}

    # Process bans sequentially
    for idx, uid in enumerate(valid_user_ids, start=1):
        print(f"[{idx}/{total_ops}] User {uid}... ", end='', flush=True)
        
        success, msg = await ban_user_with_retry(
            guild, uid, reason, delete_message_days
        )
        
        if success:
            print("✓ Success")
            results['success'] += 1
        elif msg == 'already_banned':
            print("⊘ Already banned")
            results['skipped'] += 1
        else:
            print(f"✗ {msg}")
            results['failed'] += 1

        await asyncio.sleep(DELAY_BETWEEN_BANS)

    # Send completion message
    print(f"\n{'=' * 60}")
    print(f"SERVER MASS BAN COMPLETED")
    print(f"Success: {results['success']} | Failed: {results['failed']} | Skipped: {results['skipped']}")
    print(f"{'=' * 60}\n")

    summary = (
        f'✅ Server mass ban complete!\n'
        f'• Successful: {results["success"]}\n'
        f'• Failed: {results["failed"]}\n'
        f'• Skipped: {results["skipped"]}'
    )
    
    if invalid_inputs:
        summary += f'\n⚠ Invalid inputs: {", ".join(str(x) for x in invalid_inputs[:5])}'
        if len(invalid_inputs) > 5:
            summary += f' (+{len(invalid_inputs) - 5} more)'

    await interaction.followup.send(summary, ephemeral=True)


# ============================================================================
# MAIN
# ============================================================================

def main():
    """Main entry point."""
    if not DISCORD_BOT_TOKEN:
        print("❌ ERROR: DISCORD_BOT_TOKEN environment variable not set!")
        print("Set it with: $env:DISCORD_BOT_TOKEN='your-token-here'")
        sys.exit(1)
    
    print(f"\n{'=' * 60}")
    print("Discord Moderation Bot - Python Version")
    print(f"{'=' * 60}")
    print("Starting bot...")
    print("This bot runs locally and handles long-running operations.")
    print("Press Ctrl+C to stop.")
    print(f"{'=' * 60}\n")
    
    try:
        bot.run(DISCORD_BOT_TOKEN)
    except KeyboardInterrupt:
        print("\n\nShutting down gracefully...")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
