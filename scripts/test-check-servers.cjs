// Offline behavior checks; no Discord or Cloudflare credentials needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: id => {
    if (!(id in mocks)) throw new Error(`Unexpected import: ${id}`);
    return mocks[id];
  }, console, FormData, Blob, ...globals });
  return exports;
}

(async () => {
  let guilds = [], enabled = [], rejected = null, edits = [], errors = [], uploads = [];
  const { handleCheckServers } = load('src/commands/moderation/checkservers.ts', {
    '../../types/discord': { InteractionResponseType: { DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 }, MessageFlags: { EPHEMERAL: 64 } },
    '../../utils/discord': {
      getCurrentUserGuilds: async () => guilds,
      editOriginalResponse: async (_app, _token, data) => { edits.push(data); return true; },
    },
    '../../utils/databaseExtras': { getGuildsWithGlobalBansEnabled: async () => enabled },
    './globalBanShared': { rejectUnlessSpecialUser: () => rejected, replyError: async (_i, message) => errors.push(message) },
  }, { fetch: async (_url, init) => { uploads.push(init.body); return new Response('{}'); } });
  async function run() {
    edits = []; errors = []; uploads = [];
    let pending;
    const result = await handleCheckServers({ application_id: 'app', token: 'test' }, {}, { waitUntil: p => { pending = p; } });
    await pending;
    return result;
  }
  guilds = [{ id: '1', name: 'Enabled' }, { id: '2', name: 'Disabled' }, { id: '3', name: 'Unconfigured' }];
  enabled = ['1', 'stale-server'];
  assert.equal((await run()).data.flags, 64);
  assert.match(edits[0].content, /1 with global bans enabled, 2 disabled/);
  assert.match(edits[0].content, /Unconfigured/);
  assert.doesNotMatch(edits[0].content, /stale-server/);
  enabled = ['1', '2', '3'];
  await run(); assert.match(edits[0].content, /All servers/);
  guilds = []; await run(); assert.match(edits[0].content, /Checked 0 servers/);
  guilds = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `Server ${i}` })); enabled = [];
  await run(); assert.equal(uploads.length, 1);
  assert.match(await uploads[0].get('files[0]').text(), /Server 99/);
  guilds = null; await run(); assert.equal(errors.length, 1); assert.equal(edits.length, 0);
  rejected = { type: 4 }; assert.equal((await run()).type, 4); assert.equal(edits.length, 0);

  let calls = [];
  const first = Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), name: 'Guild' }));
  const { getCurrentUserGuilds } = load('src/utils/discord.ts', {}, { fetch: async url => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? first : [{ id: '201', name: 'Last' }]));
  } });
  assert.equal((await getCurrentUserGuilds({ DISCORD_BOT_TOKEN: 'test' })).length, 201);
  assert.match(calls[1], /after=200/);
  console.log('Passed: authorization, inactive/unconfigured/stale servers, all active, empty list, file export, API failure, guild pagination.');
})().catch(error => { console.error(error); process.exitCode = 1; });
