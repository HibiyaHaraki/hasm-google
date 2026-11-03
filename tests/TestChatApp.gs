function runHASMChatUnitTests() {
  testHASMChatMarkdown();
  testHASMChatPrompts();
  testHASMChatCitationsAndFormatting();
  testHASMChatGraphExpansion();
  console.log('All HASM chat unit tests passed.');
}

function chatTestUuid_(number) {
  return '00000000-0000-4000-8000-' + ('000000000000' + number).slice(-12);
}

function assertChatThrows_(callback, fragment) {
  let error;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  assert_(error && error.message.indexOf(fragment) !== -1, 'Expected error containing: ' + fragment);
}

function chatTestNode_(number, type) {
  return {
    uuid: chatTestUuid_(number), type: type || 'EXPERIENCE',
    title: 'Negotiating priorities', fields: { takeaway: 'Make constraints visible' },
    body: 'A failed handoff improved after a shared checklist.',
    url: 'https://drive.google.com/file/d/example/view', links: ['https://example.com/source']
  };
}

function testHASMChatMarkdown() {
  const uuid = chatTestUuid_(1);
  const row = { uuid: uuid, entity_type: 'EXPERIENCE' };
  const markdown = renderHASMMarkdown_({
    uuid: uuid, title: 'A "quoted" experience', entity_type: 'EXPERIENCE',
    timestamp: '2025-01-01', link: '["https://example.com","javascript:alert(1)"]',
    fields: { takeaway: 'Ask\nthen act', emotion: 'Concerned' }, body: 'Reflection'
  });
  const node = parseHASMChatMarkdown_(markdown, row, 'https://drive.google.com/file/d/test/view');
  assertEqual_(node.fields.takeaway, 'Ask\nthen act', 'multiline JSON scalar');
  assertEqual_(node.body, 'Reflection', 'Markdown body');
  assertEqual_(node.links.length, 1, 'only safe external references exposed');
  const minimal = '---\nuuid: "' + uuid + '"\nentity_type: EXPERIENCE\ntitle: \'It\'\'s useful\'\n---\nBody';
  assertEqual_(parseHASMChatMarkdown_(minimal, row, '').links.length, 0, 'absent links default to []');
  assertEqual_(parseHASMChatMarkdown_(minimal, row, '').title, "It's useful", 'single-quoted YAML');
  assertEqual_(parseHASMChatMarkdown_(minimal.replace('title:', 'link: []\ntitle:'), row, '').links.length,
    0, 'native JSON array link');
  assertChatThrows_(function() { parseHASMChatMarkdown_('No metadata', row, ''); }, 'frontmatter');
  assertChatThrows_(function() {
    parseHASMChatMarkdown_(minimal.replace(uuid, chatTestUuid_(2)), row, '');
  }, 'mismatch');
  assertChatThrows_(function() {
    parseHASMChatMarkdown_(minimal.replace('title:', 'link: "{}"\ntitle:'), row, '');
  }, 'JSON URL array');
  assertChatThrows_(function() {
    parseHASMChatMarkdown_(minimal.replace('title:', 'title: "duplicate"\ntitle:'), row, '');
  }, 'duplicate');
  assertChatThrows_(function() {
    parseHASMChatMarkdown_(minimal.replace('title:', 'description: |\ntitle:'), row, '');
  }, 'single-line');
}

function testHASMChatPrompts() {
  const structural = buildHASMStructuralPrompt_();
  ['causal structure', 'NOT keyword', 'constraints', 'failed approaches', 'untrusted DATA', 'important differences']
    .forEach(function(term) { assert_(structural.indexOf(term) !== -1, 'retrieval prompt includes ' + term); });
  const career = buildHASMChatPrompt_('career');
  const mentor = buildHASMChatPrompt_('mentorship');
  assert_(career.indexOf('CV bullets') !== -1 && career.indexOf('STAR') !== -1, 'career prompt');
  assert_(mentor.indexOf('past failures') !== -1 && mentor.indexOf('small experiments') !== -1, 'mentorship prompt');
  [career, mentor].forEach(function(prompt) {
    ['never invent', 'untrusted data', 'History is conversational context, NOT evidence', '[uuid]', 'evidence gaps']
      .filter(function(term) { return term !== 'evidence gaps' || prompt === career; })
      .forEach(function(term) { assert_(prompt.indexOf(term) !== -1, 'grounding instruction: ' + term); });
  });
  assertChatThrows_(function() { buildHASMChatPrompt_('other'); }, 'Choose career or mentorship');
  assertChatThrows_(function() { checkHASMChatDeadline_(Date.now() - 1); }, 'work deadline');
}

function testHASMChatCitationsAndFormatting() {
  const node = chatTestNode_(1);
  const text = 'Checklist [' + node.uuid + ']. Again [' + node.uuid + '].';
  assertEqual_(parseHASMChatCitations_(text, [node]).length, 1, 'deduplicated citations');
  assertChatThrows_(function() {
    parseHASMChatCitations_('Claim [' + chatTestUuid_(2) + ']', [node]);
  }, 'unknown HASM node');
  assertChatThrows_(function() { parseHASMChatCitations_('Claim [broken]', [node]); }, 'unknown HASM node');
  assertChatThrows_(function() { parseHASMChatCitations_('Claim [', [node]); }, 'malformed citation');
  ['career', 'mentorship'].forEach(function(mode) {
    const result = { sections: hasmChatHeadings_(mode).map(function(heading) {
      return { heading: heading, text: text };
    }) };
    const response = formatHASMChatResponse_(result, mode, { nodes: [node] }, []);
    assertEqual_(response.sources[0].uuid, node.uuid, 'source identity from corpus');
    assertEqual_(response.sources[0].url, node.url, 'Drive citation URL from corpus');
    assertEqual_(response.sections.length, hasmChatHeadings_(mode).length, 'mode section count');
    assertEqual_(response.sources.length, 1, 'source deduplication');
    result.sections[0].heading = 'Invented heading';
    assertChatThrows_(function() { formatHASMChatResponse_(result, mode, { nodes: [node] }, []); }, 'invalid coaching section');
  });
  const noEvidence = { sections: hasmChatHeadings_('mentorship').map(function(heading) {
    return { heading: heading, text: 'Not enough evidence. General suggestion: clarify the constraints.' };
  }) };
  assertEqual_(formatHASMChatResponse_(noEvidence, 'mentorship', { nodes: [] }, []).sources.length,
    0, 'honest response when no evidence matches');
  assertChatThrows_(function() {
    formatHASMChatResponse_(noEvidence, 'mentorship', { nodes: [node] }, []);
  }, 'omitted evidence citations');
  noEvidence.sections[0].text = new Array(12002).join('x');
  assertChatThrows_(function() {
    formatHASMChatResponse_(noEvidence, 'mentorship', { nodes: [] }, []);
  }, 'size limit');
}

function testHASMChatGraphExpansion() {
  const nodes = [chatTestNode_(1), chatTestNode_(2, 'FACT'), chatTestNode_(3, 'PERSON'), chatTestNode_(4, 'LINK')];
  const corpus = {
    nodes: nodes,
    edges: [
      { from_uuid: nodes[0].uuid, to_uuid: nodes[1].uuid, relation: 'supports', link_uuid: nodes[3].uuid },
      { from_uuid: nodes[0].uuid, to_uuid: nodes[2].uuid, relation: 'involves' }
    ]
  };
  const context = expandHASMChatContext_(corpus, [{ uuid: nodes[0].uuid }]);
  assertEqual_(context.nodes.length, 4, 'facts, people and LINK context expanded');
  assertEqual_(context.edges.length, 2, 'graph edges retained');
  assertEqual_(expandHASMChatContext_(corpus, []).nodes.length, 0, 'no invented matches');
  for (let i = 5; i <= 30; i++) {
    corpus.nodes.push(chatTestNode_(i, 'FACT'));
    corpus.edges.push({ from_uuid: nodes[0].uuid, to_uuid: chatTestUuid_(i), relation: 'supports' });
  }
  assertEqual_(expandHASMChatContext_(corpus, [{ uuid: nodes[0].uuid }]).nodes.length,
    HASM_CHAT.MAX_CONTEXT_NODES, 'bounded graph context');
}
