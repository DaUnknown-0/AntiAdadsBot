const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');

function load(path, mocks = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { exports, require: id => {
    if (!(id in mocks)) throw new Error(`Missing mock ${id}`);
    return mocks[id];
  }, console, crypto: webcrypto, TextEncoder, TextDecoder, Response, URL, Date, Set, Map, ...globals });
  return exports;
}

(async () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync('migrations/0004_add_pending_actions.sql', 'utf8'));
  sql.exec(fs.readFileSync('migrations/0006_jobs.sql', 'utf8'));
  const db = { prepare(query) {
    const statement = sql.prepare(query);
    function bound(args) { return {
      bind: (...values) => bound(values),
      first: async () => statement.get(...args) || null,
      run: async () => statement.run(...args),
      all: async () => ({ results: statement.all(...args) }),
    }; }
    return bound([]);
  } };
  const limits = load('src/utils/jobLimits.ts');
  const { readLimitedText } = load('src/utils/input.ts', { './jobLimits': limits });
  assert.equal(await readLimitedText(new Response('ä😀').body), 'ä😀');
  await assert.rejects(readLimitedText(new Response('x'.repeat(65537)).body), /64 KiB/);
  assert.throws(() => limits.validateJobSize([{ userIds: Array(1001).fill('1') }]), /too large/);
  assert.throws(() => limits.validateJobSize(Array.from({ length: 11 }, () => ({ userIds: Array(1000).fill('1') }))), /too large/);
  assert.throws(() => limits.validateJobSize(Array.from({ length: 201 }, () => ({ userIds: [] }))), /too large/);
  let bans = 0, edits = 0, counter = 0;
  const instances = new Map();
  class Storage {
    data = new Map();
    async get(key) { return structuredClone(this.data.get(key)); }
    async put(key, value) { this.data.set(key, structuredClone(value)); }
    async setAlarm(time) { this.nextAlarm = time; }
    async getAlarm() { return this.nextAlarm ?? null; }
    async list() { return new Map(this.data); }
    async deleteAll() { this.data.clear(); }
    async delete(key) { this.data.delete(key); }
  }
  const mocks = {
    'cloudflare:workers': { DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } },
    '../utils/jobLimits': limits,
    '../utils/discord': {
      BULK_BAN_MAX_USERS: 200,
      mapWithConcurrency: async (items, _n, fn) => Promise.all(items.map(fn)),
      bulkBanUsers: async (_env, _guild, users) => { bans += users.length; return { banned: users, failed: [] }; },
      editOriginalResponse: async () => { edits++; return true; },
      isSubrequestLimitError: () => false,
      fetchGuildBanPage: async () => ({ ids: [], done: true, guildGone: false }),
    },
    '../utils/database': { createModerationCases: async () => [] },
    '../utils/databaseExtras': { getGlobalBanGuildTargets: async () => [], createPendingBanAction: async () => 'pending' },
    '../utils/banCheck': { buildBanCheckMessage: () => ({ message: 'Check complete', components: [] }) },
    '../utils/logging': { createInfoEmbed: (_title, description) => ({ description }), createSuccessEmbed: description => ({ description }), createErrorEmbed: description => ({ description }) },
  };
  const { RateLimiter } = load('src/durable-objects/RateLimiter.ts', { 'cloudflare:workers': mocks['cloudflare:workers'] });
  const rateStorage = new Storage();
  const rateLimiter = new RateLimiter({ storage: rateStorage }, {});
  await rateLimiter.fetch(new Request('https://local/check', { method: 'POST', body: JSON.stringify({ guildId: 'a', userId: 'b', timestamp: Date.now() - 400000 }) }));
  assert.ok(rateStorage.nextAlarm);
  rateStorage.nextAlarm = undefined;
  await rateLimiter.alarm();
  assert.equal(rateStorage.data.size, 0);
  assert.equal(rateStorage.nextAlarm, undefined);
  const { BanJob, startBanJob } = load('src/durable-objects/BanJob.ts', mocks);
  const env = { DB: db, BAN_JOBS: {
    newUniqueId: () => (++counter).toString(16).padStart(64, '0'),
    get(id) {
      if (!instances.has(id)) instances.set(id, new BanJob({ storage: new Storage() }, env));
      return instances.get(id);
    },
  } };
  const input = { kind: 'ban', title: 'Test ban', targets: ['a', 'b'].map(guildId => ({ guildId, userIds: ['1', '2'] })), reason: 'test', deleteMessageSeconds: 0, moderatorId: 'owner', requestKey: 'request-one' };
  await startBanJob(env, input);
  let row = sql.prepare('SELECT * FROM bot_jobs').get();
  const first = instances.get(row.id);
  const state = await first.ctx.storage.get('state');
  assert.equal(state.queue[0].userListKey, state.queue[1].userListKey);
  assert.equal(state.queue[0].userIds.length, 0);
  assert.equal([...first.ctx.storage.data.keys()].filter(k => k.startsWith('users:')).length, 1);
  await startBanJob(env, input);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM bot_jobs').get().n, 1);
  await assert.rejects(startBanJob(env, { ...input, requestKey: 'other' }), /Another moderation job/);
  await first.alarm();
  assert.equal(bans, 4);
  row = sql.prepare('SELECT * FROM bot_jobs').get();
  assert.equal(row.status, 'completed');
  assert.match(row.summary, /Successes: 4/);
  assert.equal(first.ctx.storage.data.size, 0);

  await startBanJob(env, { ...input, requestKey: 'cancel-test' });
  row = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  sql.prepare("UPDATE bot_jobs SET status = 'cancel_requested' WHERE id = ?").run(row.id);
  await instances.get(row.id).alarm();
  assert.equal(bans, 4);
  assert.equal(sql.prepare('SELECT status FROM bot_jobs WHERE id = ?').get(row.id).status, 'cancelled');

  await startBanJob(env, { ...input, kind: 'check', requestKey: 'long-check', targets: [{ guildId: 'a', userIds: [] }], check: { userIds: ['1'], variant: 'audit', onComplete: 'report' }, interaction: { applicationId: 'app', token: 'token' } });
  row = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  const long = instances.get(row.id);
  const old = await long.ctx.storage.get('state'); old.createdAt = Date.now() - 16 * 60000;
  await long.ctx.storage.put('state', old);
  const before = edits;
  await long.alarm();
  assert.equal(edits, before);
  assert.equal(sql.prepare('SELECT summary FROM bot_jobs WHERE id = ?').get(row.id).summary, 'Check complete');

  await startBanJob(env, { ...input, requestKey: 'expired-lease' });
  row = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  sql.prepare('UPDATE bot_jobs SET lease_until = 0 WHERE id = ?').run(row.id);
  await startBanJob(env, { ...input, requestKey: 'new-lease' });
  await instances.get(row.id).alarm();
  assert.equal(bans, 4);
  const active = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  assert.notEqual(active.id, row.id);
  await instances.get(active.id).alarm();
  assert.equal(bans, 8);

  let reply, rejection = null;
  const { handleJobCommand } = load('src/commands/moderation/jobs.ts', {
    '../../types/discord': { InteractionResponseType: { DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 }, MessageFlags: { EPHEMERAL: 64 } },
    '../../utils/discord': { editOriginalResponse: async (_a, _t, data) => { reply = data; }, getGuild: async () => ({ name: 'Test server' }), getGuildMember: async () => ({ roles: ['bot-role'] }) },
    '../../utils/permissions': { getGuildConfig: async () => ({ global_bans_enabled: 1 }) },
    './globalBanShared': { rejectUnlessSpecialUser: () => rejection, replyError: async (_i, message) => { throw new Error(message); } },
  }, { fetch: async () => new Response(JSON.stringify([{ id: 'guild', permissions: '4' }, { id: 'bot-role', permissions: '32' }])) });
  async function command(name, id) {
    let pending;
    const result = await handleJobCommand({ guild_id: 'guild', data: { name, options: id ? [{ name: 'id', value: id }] : [] } }, env, { waitUntil: p => { pending = p; } });
    await pending;
    return result;
  }
  assert.equal((await command('job-status', active.id)).data.flags, 64);
  assert.match(reply.content, /completed/);
  await command('server-health');
  assert.match(reply.content, /Ban Members: yes/);
  assert.match(reply.content, /Manage Server \(bulk bans\): yes/);
  await startBanJob(env, { ...input, requestKey: 'cancel-command' });
  row = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  await command('cancel-job', row.id);
  assert.equal(sql.prepare('SELECT status FROM bot_jobs WHERE id = ?').get(row.id).status, 'cancel_requested');
  rejection = { type: 4 };
  assert.equal((await command('job-status')).type, 4);
  await instances.get(row.id).alarm();
  await startBanJob(env, { ...input, requestKey: 'storage-recovery' });
  row = sql.prepare("SELECT * FROM bot_jobs WHERE status = 'running'").get();
  const recovery = instances.get(row.id);
  const originalGet = recovery.ctx.storage.get.bind(recovery.ctx.storage);
  recovery.ctx.storage.get = async key => key.startsWith('users:') ? undefined : originalGet(key);
  await recovery.alarm();
  assert.equal((await originalGet('state')).queue.length, 2);
  recovery.ctx.storage.get = originalGet;
  await recovery.alarm();
  assert.equal(sql.prepare('SELECT status FROM bot_jobs WHERE id = ?').get(row.id).status, 'completed');

  sql.exec("INSERT INTO pending_ban_actions(id,user_ids,requested_by) VALUES ('button','[]','owner')");
  const claim = sql.prepare("UPDATE pending_ban_actions SET claim_until = ?, claim_token = ? WHERE id = 'button' AND claim_until < ? RETURNING id");
  assert.equal(claim.get(200, 'one', 100).id, 'button');
  assert.equal(claim.get(250, 'two', 150), undefined);
  assert.equal(claim.get(400, 'two', 300).id, 'button');
  sql.close();
  console.log('Passed: bounded input, rate-limiter cleanup, job limits, shared lists, atomic exclusivity, deduplication, completion persistence, cancellation, lease expiry, expired interaction results, recoverable button claims, status/cancel/health commands and authorization.');
})().catch(error => { console.error(error); process.exitCode = 1; });
