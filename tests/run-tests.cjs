'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const rootPath = path.resolve(__dirname, '..');
let currentUser = 'owner';
const userCaches = new Map();
let locked = false;
let lockAvailable = true;
let markdownReads = 0;
const apiQueue = [];
const properties = new Map([['GEMINI_API_KEY', 'test-key']]);

function blob(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { getBytes: () => Array.from(bytes), getDataAsString: () => bytes.toString('utf8') };
}

function makeCache() {
  const entries = new Map();
  return {
    entries,
    get(key) { return entries.get(key) || null; },
    getAll(keys) { return Object.fromEntries(keys.map(key => [key, this.get(key)])); },
    put(key, value, ttl) {
      assert.ok(Buffer.byteLength(value) < 100 * 1024, 'CacheService value limit');
      assert.equal(ttl, 600);
      entries.set(key, value);
    },
    putAll(values, ttl) { Object.entries(values).forEach(([key, value]) => this.put(key, value, ttl)); }
  };
}

function userCache() {
  if (!userCaches.has(currentUser)) { userCaches.set(currentUser, makeCache()); }
  return userCaches.get(currentUser);
}

function iterator(items) {
  let index = 0;
  return { hasNext: () => index < items.length, next: () => items[index++] };
}

function folder(name, children = []) {
  return {
    name, children,
    getId: () => 'folder-' + name,
    getFoldersByName: child => iterator(children.filter(item => item.children && item.name === child)),
    getFilesByName: child => iterator(children.filter(item => !item.children && item.name === child))
  };
}

function file(name, content) {
  return {
    name,
    getSize: () => Buffer.byteLength(content),
    getBlob() { if (name === 'main.md') { markdownReads++; } return blob(content); },
    getUrl: () => 'https://drive.google.com/file/d/' + crypto.randomUUID() + '/view'
  };
}

let driveRoot;
const context = vm.createContext({
  console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null }) },
  CacheService: { getUserCache: userCache },
  LockService: { getUserLock: () => ({
    tryLock() { if (!lockAvailable || locked) { return false; } locked = true; return true; },
    releaseLock() { locked = false; }
  }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    newBlob: value => blob(Array.isArray(value) ? Buffer.from(value) : value),
    gzip: value => blob(zlib.gzipSync(Buffer.from(value.getBytes()))),
    ungzip: value => blob(zlib.gunzipSync(Buffer.from(value.getBytes()))),
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    base64Decode: text => Array.from(Buffer.from(text, 'base64'))
  },
  DriveApp: {
    getFoldersByName: name => iterator(driveRoot && driveRoot.name === name ? [driveRoot] : []),
    getFolderById: id => {
      assert.equal(id, driveRoot.getId());
      return driveRoot;
    }
  },
  HtmlService: { createHtmlOutputFromFile: name => {
    assert.equal(name, 'Chat');
    const output = { setTitle: () => output, addMetaTag: () => output };
    return output;
  } },
  UrlFetchApp: { fetch(url, options) {
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    assert.ok(!url.includes('test-key'), 'API key must not be in URL');
    assert.ok(apiQueue.length, 'Unexpected API call');
    const item = apiQueue.shift();
    const payload = JSON.parse(options.payload);
    item.check?.(payload);
    return {
      getResponseCode: () => item.status || 200,
      getContentText: () => JSON.stringify(item.envelope || {
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(item.result) }] } }]
      })
    };
  } }
});

for (const name of fs.readdirSync(rootPath).filter(name => name.endsWith('.gs')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(rootPath, name), 'utf8'), context, { filename: name });
}
for (const name of ['TestSyncHASM.gs', 'TestChatApp.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), context, { filename: name });
}
const run = code => vm.runInContext(code, context);
run('runHASMUnitTests(); runHASMChatUnitTests(); doGet();');

const uuid = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const rows = ['EXPERIENCE', 'FACT', 'PERSON', 'LINK'].map((type, i) => ({
  uuid: uuid(i + 1), entity_type: type, path: type + '/' + uuid(i + 1) + '/main.md'
}));
const database = {
  schema_version: 2,
  person: [{
    person_id: uuid(3), life_experience_id: uuid(1), person_name: 'Ada',
    person_description: 'A project lead.', link: [], security_level: 0
  }],
  experience: [{
    experience_id: uuid(1), experience_name: 'Constraint negotiation',
    experience_description: 'First failed, then used a shared checklist.',
    link: ['https://example.com'], security_level: 0
  }],
  experience_tree: [],
  fact: [{
    fact_id: uuid(2), fact_name: 'Used a checklist', fact_description: 'The team used a shared checklist.',
    link: ['https://example.com'], occurred_at: '2025-01-01', start_time: '2025-01-01',
    end_time: '2025-01-01', security_level: 0
  }],
  fact_experience: [{ fact_id: uuid(2), experience_id: uuid(1) }],
  link: [{
    link_id: uuid(4), link_type: 'supports', link_description: 'Connects the experience and fact.',
    link: ['https://example.com'], origin_entity_type: 'Experience', origin_entity_id: uuid(1),
    target_entity_type: 'Fact', target_entity_id: uuid(2), security_level: 0
  }],
  link_relation: [],
  sync_metadata: { source_keys: {}, assets_by_id: {}, legacy_entities: [], legacy_links: [] }
};
context.validateHASMDatabase_(database);
driveRoot = folder('hasm_root', [
  file('hasm.db', JSON.stringify(database)),
  ...rows.map(row => folder(row.entity_type, [folder(row.uuid, [
    file('main.md', context.renderHASMMarkdown_({
      ...row, title: row.entity_type === 'LINK' ? 'Explicit edge' : 'Constraint negotiation',
      timestamp: '2025-01-01', link: ['https://example.com'],
      fields: row.entity_type === 'LINK'
        ? { origin_entity_type: 'Experience', origin_entity_id: uuid(1), target_entity_type: 'Fact',
          target_entity_id: uuid(2), link_type: 'supports' }
        : { description: 'First failed, then used a shared checklist.', takeaway: 'Expose constraints' },
      body: 'A team handoff failed; a checklist clarified responsibilities.'
    })), folder('assets')
  ])]))
]);

const first = context.startHASMChat('career', false);
assert.equal(first.nodeCount, 4);
assert.equal(markdownReads, 4);
context.startHASMChat('mentorship', false);
assert.equal(markdownReads, 4, 'cache avoids repeat Drive traversal');
context.startHASMChat('career', true);
assert.equal(markdownReads, 8, 'explicit refresh reads changed Markdown');
const match = { uuid: uuid(1), score: 0.9, rationale: 'Both involve unclear ownership under competing constraints.' };
const careerResult = {
  sections: context.hasmChatHeadings_('career').map(heading => ({
    heading, text: 'Supported checklist action [' + uuid(1) + '].'
  }))
};

function queueTurn(historyLength) {
  apiQueue.push({
    result: { matches: [match] },
    check(payload) {
      const input = JSON.parse(payload.contents[0].parts[0].text);
      assert.equal(input.history.length, historyLength);
      assert.equal(input.nodes.length, 2, 'only experience and fact nodes are ranked');
      assert.ok(input.nodes[0].metadata.takeaway);
      assert.ok(payload.systemInstruction.parts[0].text.includes('NOT keyword'));
    }
  }, {
    result: careerResult,
    check(payload) {
      const input = JSON.parse(payload.contents[0].parts[0].text);
      assert.equal(input.nodes.length, 4, 'related people and links included in generation');
      assert.equal(input.relations.length, 4);
      assert.ok(payload.generationConfig.responseSchema);
    }
  });
}

for (let turn = 0; turn < 5; turn++) {
  queueTurn(Math.min(turn, 3));
  const response = context.sendHASMChatMessage(first.sessionId, 'Help me tell the ownership story.');
  assert.equal(response.sources[0].uuid, uuid(1));
  assert.equal(response.mode, 'career');
  assert.equal(locked, false);
}
assert.equal(apiQueue.length, 0);
assert.equal(context.getHASMChatCache_(userCache(), 'hasm-chat:session:' + first.sessionId).history.length, 3);

currentUser = 'other';
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /expired or was evicted/);
currentUser = 'owner';
lockAvailable = false;
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /Another chat request/);
lockAvailable = true;
assert.throws(() => context.sendHASMChatMessage('../bad', 'Hi'), /Invalid chat session/);
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'x'.repeat(4001)), /4000/);
assert.throws(() => context.sendHASMChatMessage(first.sessionId, '  '), /4000/);

apiQueue.push({ status: 429 });
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /HTTP 429/);
assert.equal(locked, false, 'errors release the user lock');
assert.equal(context.getHASMChatCache_(userCache(), 'hasm-chat:session:' + first.sessionId).history.length, 3,
  'failed request does not change history');
apiQueue.push({ envelope: { candidates: [{ finishReason: 'MAX_TOKENS' }] } });
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /incomplete/);
apiQueue.push({ result: { matches: [{ ...match, uuid: uuid(99) }] } });
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /unsupported structural match/);

const mentor = context.startHASMChat('mentorship', false);
apiQueue.push({ result: { matches: [] } }, {
  result: { sections: context.hasmChatHeadings_('mentorship').map(heading => ({
    heading, text: 'No matching evidence. General suggestion: clarify the blocker.'
  })) }
});
assert.equal(context.sendHASMChatMessage(mentor.sessionId, 'Unrelated question').sources.length, 0);

const manyNodes = Array.from({ length: 21 }, (_, i) => context.chatTestNode_(i + 1));
apiQueue.push(
  { result: { matches: [match] } },
  { result: { matches: [{ uuid: uuid(21), score: 0.95, rationale: 'Stronger supported causal analogy.' }] } }
);
const ranked = context.retrieveHASMChatMatches_({ nodes: manyNodes, edges: [] }, 'Challenge', [], { apiKey: 'test-key', model: 'test' });
assert.equal(ranked[0].uuid, uuid(21), 'global ranking includes later batches');
apiQueue.push({ result: { matches: [{ ...match, score: 0.1 }] } });
assert.throws(() => context.retrieveHASMChatMatches_({ nodes: manyNodes, edges: [] },
  'Challenge', [], { apiKey: 'test-key', model: 'test' }), /unsupported structural match/);
apiQueue.push({ result: { matches: [match, match] } });
assert.throws(() => context.retrieveHASMChatMatches_({ nodes: manyNodes, edges: [] },
  'Challenge', [], { apiKey: 'test-key', model: 'test' }), /unsupported structural match/);

const cache = userCache();
const randomText = crypto.randomBytes(150000).toString('base64');
context.putHASMChatCache_(cache, 'large', { text: randomText });
assert.equal(context.getHASMChatCache_(cache, 'large').text, randomText, 'chunked Unicode-safe cache roundtrip');
const manifest = JSON.parse(cache.get('large'));
assert.ok(manifest.count > 1, 'test actually spans cache chunks');
cache.entries.delete('large:' + manifest.generation + ':0');
assert.equal(context.getHASMChatCache_(cache, 'large'), null, 'evicted chunk invalidates complete cache value');
assert.throws(() => context.putHASMChatCache_(cache, 'too-large', {
  text: crypto.randomBytes(1000000).toString('base64')
}), /cache budget/);
context.putHASMChatCache_(cache, 'unicode', { text: '経験と振り返り' });
assert.equal(context.getHASMChatCache_(cache, 'unicode').text, '経験と振り返り');

const sessionManifest = JSON.parse(cache.get('hasm-chat:session:' + first.sessionId));
cache.entries.delete('hasm-chat:session:' + first.sessionId + ':' + sessionManifest.generation + ':0');
assert.throws(() => context.sendHASMChatMessage(first.sessionId, 'Hi'), /expired or was evicted/);
assert.equal(locked, false);

const originalRoot = driveRoot;
driveRoot = folder('hasm_root', [file('hasm.db', JSON.stringify({ schema_version: 1, entities: [], links: [] }))]);
assert.equal(context.readHASMChatCorpus_(driveRoot).nodes.length, 0);
driveRoot = folder('hasm_root');
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /Missing HASM item: hasm.db/);
assert.throws(() => context.startHASMChat('unsupported', true), /Choose career or mentorship/);
driveRoot = undefined;
assert.throws(() => context.startHASMChat('career', true), /No HASM root exists/);
driveRoot = originalRoot;
properties.set('HASM_CHAT_ROOT_FOLDER_ID', driveRoot.getId());
assert.equal(context.startHASMChat('career', true).nodeCount, 4, 'configured folder ID is respected');
properties.delete('HASM_CHAT_ROOT_FOLDER_ID');
const experienceFile = driveRoot.children[1].children[0].children[0];
driveRoot.children[1].children[0].children[0] = file('main.md', 'x'.repeat(16001));
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /16000 characters/);
driveRoot.children[1].children[0].children[0] = experienceFile;
driveRoot.children.push(driveRoot.children[1]);
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /Ambiguous HASM item/);
driveRoot.children.pop();
const linkFolder = driveRoot.children[4].children[0];
const originalLinkFile = linkFolder.children[0];
linkFolder.children[0] = file('main.md', context.renderHASMMarkdown_({
  ...rows[3], title: 'Explicit edge', timestamp: '2025-01-01', link: [],
  fields: { from_uuid: uuid(1), to_uuid: uuid(2), relation: 'clarifies' }, body: ''
}));
const explicitEdge = context.readHASMChatCorpus_(driveRoot).edges.find(edge => edge.from_uuid === uuid(4));
assert.equal(explicitEdge.to_uuid, uuid(2), 'LINK UUID endpoints contribute graph edges');
linkFolder.children[0] = originalLinkFile;
database.sync_metadata.legacy_entities.push({
  uuid: uuid(99), entity_type: 'FACT', path: '../outside/main.md'
});
driveRoot.children[0] = file('hasm.db', JSON.stringify(database));
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /Invalid HASM entity path/);
database.sync_metadata.legacy_entities.pop();
database.link[0].target_entity_id = uuid(999);
driveRoot.children[0] = file('hasm.db', JSON.stringify(database));
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /dangling HASM graph/);
database.link[0].target_entity_id = uuid(2);
database.experience.push(database.experience[0]);
driveRoot.children[0] = file('hasm.db', JSON.stringify(database));
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /Invalid or duplicate HASM entity/);
database.experience = Array.from({ length: 301 }, (_, i) => ({
  experience_id: uuid(i + 100), experience_name: 'Many', experience_description: '',
  link: [], security_level: 0
}));
driveRoot.children[0] = file('hasm.db', JSON.stringify(database));
assert.throws(() => context.readHASMChatCorpus_(driveRoot), /up to 300 entities/);
assert.equal(apiQueue.length, 0);

const html = fs.readFileSync(path.join(rootPath, 'Chat.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script, { filename: 'Chat.html' });
assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(script), 'chat never injects model HTML');
assert.ok(script.includes('withFailureHandler') && script.includes('aria-busy'));
JSON.parse(fs.readFileSync(path.join(rootPath, 'appsscript.json'), 'utf8'));
console.log('All local integration tests and browser-script syntax checks passed.');
