import { DurableObject } from 'cloudflare:workers';

interface ScheduledAction {
  id: string;
  guildId: string;
  userId: string;
  actionType: 'unban' | 'unmute' | 'untimeout';
  executeAt: number;
  caseId?: number;
  discordBotToken: string;
}

/**
 * ScheduledActions Durable Object
 * Handles scheduled moderation actions (timed bans, mutes, timeouts)
 * 
 * Each guild gets its own instance to manage scheduled actions
 */
export class ScheduledActions extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/schedule' && request.method === 'POST') {
      return this.scheduleAction(request);
    }

    if (url.pathname === '/cancel' && request.method === 'POST') {
      return this.cancelAction(request);
    }

    if (url.pathname === '/list' && request.method === 'GET') {
      return this.listActions();
    }

    return new Response('Not Found', { status: 404 });
  }

  private async scheduleAction(request: Request): Promise<Response> {
    const action = await request.json() as ScheduledAction;
    const actionId = action.id || crypto.randomUUID();

    // Store the action
    await this.ctx.storage.put(actionId, action);

    // Calculate next alarm time (earliest scheduled action)
    const nextAlarm = await this.calculateNextAlarm();
    if (nextAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }

    return new Response(
      JSON.stringify({ success: true, actionId }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async cancelAction(request: Request): Promise<Response> {
    const { actionId } = await request.json() as { actionId: string };

    const deleted = await this.ctx.storage.delete(actionId);

    // Recalculate alarm
    const nextAlarm = await this.calculateNextAlarm();
    if (nextAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }

    return new Response(
      JSON.stringify({ success: deleted, message: deleted ? 'Action cancelled' : 'Action not found' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async listActions(): Promise<Response> {
    const allActions = await this.ctx.storage.list<ScheduledAction>();
    const actions = Array.from(allActions.values());

    return new Response(
      JSON.stringify({ actions }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  private async calculateNextAlarm(): Promise<number | null> {
    const allActions = await this.ctx.storage.list<ScheduledAction>();
    
    if (allActions.size === 0) {
      return null;
    }

    let earliestTime: number | null = null;

    for (const action of allActions.values()) {
      if (!earliestTime || action.executeAt < earliestTime) {
        earliestTime = action.executeAt;
      }
    }

    return earliestTime;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const allActions = await this.ctx.storage.list<ScheduledAction>();

    // Execute all actions that are due
    for (const [actionId, action] of allActions.entries()) {
      if (action.executeAt <= now) {
        try {
          await this.executeAction(action);
          await this.ctx.storage.delete(actionId);
        } catch (error) {
          console.error(`Failed to execute action ${actionId}:`, error);
          // Keep the action for retry, but log the error
        }
      }
    }

    // Schedule next alarm
    const nextAlarm = await this.calculateNextAlarm();
    if (nextAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  private async executeAction(action: ScheduledAction): Promise<void> {
    const baseUrl = 'https://discord.com/api/v10';

    switch (action.actionType) {
      case 'unban':
        // Unban user
        await fetch(`${baseUrl}/guilds/${action.guildId}/bans/${action.userId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bot ${action.discordBotToken}`,
          },
        });
        break;

      case 'unmute':
        // Remove mute role (implementation depends on mute system)
        // This is a placeholder - actual implementation depends on how mute is handled
        console.log(`Unmute action for user ${action.userId} in guild ${action.guildId}`);
        break;

      case 'untimeout':
        // Remove timeout
        await fetch(`${baseUrl}/guilds/${action.guildId}/members/${action.userId}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bot ${action.discordBotToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            communication_disabled_until: null,
          }),
        });
        break;
    }
  }
}
