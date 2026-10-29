export const MAX_JOB_USERS = 1000;
export const MAX_JOB_GUILDS = 200;
export const MAX_JOB_PAIRS = 10000;
export const MAX_INPUT_BYTES = 64 * 1024;

export function validateJobSize(targets: Array<{ userIds: string[] }>, checkUsers?: string[]): void {
  if (targets.length > MAX_JOB_GUILDS || (checkUsers?.length || 0) > MAX_JOB_USERS ||
      targets.some(t => t.userIds.length > MAX_JOB_USERS) ||
      (checkUsers ? checkUsers.length * targets.length : targets.reduce((n, t) => n + t.userIds.length, 0)) > MAX_JOB_PAIRS) {
    throw new Error(`Job too large: maximum ${MAX_JOB_USERS} users, ${MAX_JOB_GUILDS} servers and ${MAX_JOB_PAIRS} user/server pairs. Split the request.`);
  }
}
