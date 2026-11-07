function tokenizeHASMChatText_(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  (lower.match(/[a-z0-9]{2,}/g) || []).forEach(function(word) { tokens.push(word); });
  (lower.match(/[\u3040-\u30ff\u3400-\u9fff]+/g) || []).forEach(function(run) {
    if (run.length === 1) {
      tokens.push(run);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      tokens.push(run.substring(i, i + 2));
    }
  });
  return tokens;
}

function hasmChatNodeText_(node) {
  const fields = node.fields || {};
  return [node.title, node.body].concat(Object.keys(fields).map(function(key) {
    return typeof fields[key] === 'string' ? fields[key] : '';
  })).join('\n');
}

// Local BM25-style shortlist so Gemini only reranks the most plausible nodes.
function shortlistHASMChatCandidates_(candidates, queryText, size) {
  if (candidates.length <= size) {
    return candidates;
  }
  const queryTerms = {};
  tokenizeHASMChatText_(queryText).forEach(function(token) { queryTerms[token] = true; });
  const docs = candidates.map(function(node) {
    const counts = {};
    const tokens = tokenizeHASMChatText_(hasmChatNodeText_(node));
    tokens.forEach(function(token) { counts[token] = (counts[token] || 0) + 1; });
    return { node: node, counts: counts, length: tokens.length || 1 };
  });
  const documentFrequency = {};
  docs.forEach(function(doc) {
    Object.keys(doc.counts).forEach(function(token) {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    });
  });
  const averageLength = docs.reduce(function(sum, doc) { return sum + doc.length; }, 0) / docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const scored = docs.map(function(doc, index) {
    let score = 0;
    Object.keys(queryTerms).forEach(function(token) {
      const frequency = doc.counts[token];
      if (!frequency) {
        return;
      }
      const idf = Math.log(1 + (docs.length - documentFrequency[token] + 0.5) / (documentFrequency[token] + 0.5));
      score += idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * doc.length / averageLength));
    });
    return { node: doc.node, score: score, index: index };
  });
  return scored.sort(function(left, right) {
    return right.score - left.score || left.index - right.index;
  }).slice(0, size).map(function(item) { return item.node; });
}
