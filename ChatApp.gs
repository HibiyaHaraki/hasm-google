function doGet() {
  return HtmlService.createHtmlOutputFromFile('Chat')
    .setTitle('HASM Coach')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function startHASMChat(mode, refresh) {
  hasmChatHeadings_(mode);
  const config = getHASMChatConfig_();
  const cache = CacheService.getUserCache();
  const root = getHASMChatRoot_(config);
  const corpusKey = 'hasm-chat:corpus:' + root.getId();
  let corpus = refresh === true ? null : getHASMChatCache_(cache, corpusKey);
  if (!corpus) {
    corpus = readHASMChatCorpus_(root);
    putHASMChatCache_(cache, corpusKey, corpus);
  }
  const sessionId = Utilities.getUuid();
  putHASMChatCache_(cache, 'hasm-chat:session:' + sessionId, {
    mode: mode, corpusKey: corpusKey, history: []
  });
  return {
    sessionId: sessionId, mode: mode, nodeCount: corpus.nodes.length,
    cacheSeconds: HASM_CHAT.CACHE_SECONDS
  };
}

function sendHASMChatMessage(sessionId, message) {
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
    const session = getHASMChatCache_(cache, sessionKey);
    const corpus = session && getHASMChatCache_(cache, session.corpusKey);
    if (!session || !corpus) {
      throw new Error('Chat cache expired or was evicted. Start a new conversation to reload your records.');
    }
    const response = generateHASMChatResponse_(
      session.mode, message.trim(), session.history, corpus, getHASMChatConfig_());
    session.history.push({
      user: message.trim(),
      assistant: response.sections.map(function(section) { return section.heading + '\n' + section.text; }).join('\n\n')
    });
    session.history = session.history.slice(-HASM_CHAT.MAX_HISTORY_TURNS);
    putHASMChatCache_(cache, sessionKey, session);
    return response;
  } finally {
    lock.releaseLock();
  }
}
