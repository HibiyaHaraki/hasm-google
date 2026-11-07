function doGet() {
  return HtmlService.createHtmlOutputFromFile('Chat')
    .setTitle('HASM Coach')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function loadHASMChatCorpus_(cache, refresh) {
  const config = getHASMChatConfig_();
  const root = getHASMChatRoot_(config);
  const corpusKey = 'hasm-chat:corpus:' + root.getId();
  let corpus = refresh === true ? null : getHASMChatCache_(cache, corpusKey);
  if (!corpus) {
    corpus = readHASMChatCorpus_(root);
    reportHASMChatProgress_('Caching records for fast chat', 1, 1);
    putHASMChatCache_(cache, corpusKey, corpus);
  }
  return { corpus: corpus, corpusKey: corpusKey };
}

function startHASMChat(mode, refresh) {
  hasmChatHeadings_(mode);
  const cache = CacheService.getUserCache();
  reportHASMChatProgress_('Locating your HASM folder', 0, 0);
  const loaded = loadHASMChatCorpus_(cache, refresh);
  const sessionId = Utilities.getUuid();
  putHASMChatCache_(cache, 'hasm-chat:session:' + sessionId, {
    mode: mode, corpusKey: loaded.corpusKey, history: []
  });
  reportHASMChatProgress_('Ready', 1, 1);
  return {
    sessionId: sessionId, mode: mode, nodeCount: loaded.corpus.nodes.length,
    cacheSeconds: HASM_CHAT.CACHE_SECONDS
  };
}

function getHASMChatProgress() {
  const raw = CacheService.getUserCache().get(HASM_CHAT.PROGRESS_KEY);
  return raw ? JSON.parse(raw) : null;
}

function reportHASMChatProgress_(stage, done, total) {
  try {
    CacheService.getUserCache().put(
      HASM_CHAT.PROGRESS_KEY, JSON.stringify({ stage: stage, done: done, total: total }), HASM_CHAT.CACHE_SECONDS);
  } catch (error) {
    console.warn('Could not record chat progress: ' + error.message);
  }
}

function sendHASMChatMessage(sessionId, message, mode) {
  if (typeof sessionId !== 'string' || !HASM_CHAT.UUID_PATTERN.test(sessionId)) {
    throw new Error('Invalid chat session. Start a new conversation.');
  }
  if (typeof message !== 'string' || !message.trim() || message.length > HASM_CHAT.MAX_MESSAGE_CHARS) {
    throw new Error('Enter a message between 1 and ' + HASM_CHAT.MAX_MESSAGE_CHARS + ' characters.');
  }
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    throw new Error('Another chat request is running. Wait for it to finish.');
  }
  try {
    const cache = CacheService.getUserCache();
    const sessionKey = 'hasm-chat:session:' + sessionId;
    let session = getHASMChatCache_(cache, sessionKey);
    let notice = '';
    if (!session) {
      // Recreate an evicted session under the same ID; only the conversation memory is lost.
      if (mode !== 'career' && mode !== 'mentorship') {
        throw new Error('Chat cache expired or was evicted. Start a new conversation to reload your records.');
      }
      session = { mode: mode, corpusKey: '', history: [] };
      notice = 'The chat session had expired, so it was restored. Earlier conversation turns were forgotten.';
    }
    let corpus = session.corpusKey ? getHASMChatCache_(cache, session.corpusKey) : null;
    if (!corpus) {
      reportHASMChatProgress_('Reloading records from Drive', 0, 0);
      const loaded = loadHASMChatCorpus_(cache, true);
      corpus = loaded.corpus;
      session.corpusKey = loaded.corpusKey;
      notice = notice || 'The record cache had expired, so records were reloaded from Drive.';
    }
    const response = generateHASMChatResponse_(
      session.mode, message.trim(), session.history, corpus, getHASMChatConfig_());
    if (notice) {
      response.notice = notice;
    }
    session.history.push({
      user: message.trim(),
      assistant: response.sections.map(function(section) { return section.heading + '\n' + section.text; }).join('\n\n')
    });
    session.history = session.history.slice(-HASM_CHAT.MAX_HISTORY_TURNS);
    putHASMChatCache_(cache, sessionKey, session);
    reportHASMChatProgress_('Done', 1, 1);
    return response;
  } finally {
    lock.releaseLock();
  }
}
