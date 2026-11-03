const HASM_CHAT = Object.freeze({
  CACHE_SECONDS: 600,
  CACHE_CHUNK_SIZE: 80000,
  MAX_CACHE_CHUNKS: 12,
  MAX_ENTITIES: 300,
  MAX_NODE_CHARS: 16000,
  MAX_MESSAGE_CHARS: 4000,
  MAX_HISTORY_TURNS: 3,
  RETRIEVAL_BATCH_SIZE: 20,
  MAX_MATCHES: 5,
  MAX_CONTEXT_NODES: 15,
  UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
});

function getHASMChatConfig_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    apiKey: requiredProperty_(properties, 'GEMINI_API_KEY'),
    model: properties.getProperty('GEMINI_MODEL') || HASM.DEFAULT_MODEL,
    rootFolderId: properties.getProperty('HASM_CHAT_ROOT_FOLDER_ID') || ''
  };
}

function getHASMChatRoot_(config) {
  if (config.rootFolderId) {
    return DriveApp.getFolderById(config.rootFolderId);
  }
  const folders = DriveApp.getFoldersByName(HASM.ROOT_FOLDER_NAME);
  if (!folders.hasNext()) {
    throw new Error('No HASM root exists. Run syncHASM or set HASM_CHAT_ROOT_FOLDER_ID.');
  }
  const root = folders.next();
  if (folders.hasNext()) {
    throw new Error('Multiple HASM roots exist. Set HASM_CHAT_ROOT_FOLDER_ID explicitly.');
  }
  return root;
}

function singleHASMChatChild_(parent, name, folders) {
  const children = folders ? parent.getFoldersByName(name) : parent.getFilesByName(name);
  if (!children.hasNext()) {
    throw new Error('Missing HASM item: ' + name);
  }
  const child = children.next();
  if (children.hasNext()) {
    throw new Error('Ambiguous HASM item: ' + name);
  }
  return child;
}

function parseHASMChatMarkdown_(markdown, row, fileUrl) {
  const match = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error('Missing YAML frontmatter for ' + row.uuid);
  }
  const fields = Object.create(null);
  match[1].split(/\r?\n/).forEach(function(line) {
    if (!line.trim() || /^\s*#/.test(line)) {
      return;
    }
    const field = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*?)\s*$/);
    if (!field || Object.prototype.hasOwnProperty.call(fields, field[1])) {
      throw new Error('Unsupported or duplicate YAML field for ' + row.uuid + ': ' + line);
    }
    const raw = field[2];
    if (/^["\[{]/.test(raw)) {
      fields[field[1]] = JSON.parse(raw);
    } else if (raw.charAt(0) === "'" && raw.charAt(raw.length - 1) === "'") {
      fields[field[1]] = raw.slice(1, -1).replace(/''/g, "'");
    } else {
      if (/^[>|&*!]/.test(raw)) {
        throw new Error('Use single-line JSON-compatible YAML scalars for ' + row.uuid);
      }
      fields[field[1]] = raw;
    }
  });
  if (fields.uuid !== row.uuid || fields.entity_type !== row.entity_type ||
      typeof fields.title !== 'string' || !fields.title.trim()) {
    throw new Error('HASM index/frontmatter mismatch for ' + row.uuid);
  }
  let links = fields.link === undefined ? [] : fields.link;
  if (typeof links === 'string') {
    links = JSON.parse(links);
  }
  if (!Array.isArray(links) || links.some(function(url) { return !isValidHASMUrl_(url); })) {
    throw new Error('HASM link must be a JSON URL array for ' + row.uuid);
  }
  return {
    uuid: row.uuid,
    type: row.entity_type,
    title: fields.title,
    fields: fields,
    body: match[2].trim(),
    url: fileUrl,
    links: uniqueStrings_(links)
  };
}

function readHASMChatCorpus_(root) {
  const databaseFile = singleHASMChatChild_(root, HASM.DATABASE_FILE_NAME, false);
  const database = JSON.parse(databaseFile.getBlob().getDataAsString('UTF-8'));
  if (!database || typeof database !== 'object') {
    throw new Error('HASM database must be a JSON object.');
  }
  let rows;
  let edges = [];
  if (database.schema_version === 2) {
    rows = hasmChatModelRows_(database);
    edges = hasmChatModelEdges_(database);
  } else if (database.schema_version === 1 && Array.isArray(database.entities) &&
      Array.isArray(database.links)) {
    rows = database.entities;
    edges = database.links.map(function(edge) {
      return {
        from_uuid: edge.from_uuid,
        to_uuid: edge.to_uuid,
        relation: edge.relation
      };
    });
  } else {
    throw new Error('Chat requires a supported JSON HASM database schema.');
  }
  if (rows.length > HASM_CHAT.MAX_ENTITIES) {
    throw new Error('Chat supports up to ' + HASM_CHAT.MAX_ENTITIES + ' entities per root. Use a smaller curated HASM root.');
  }
  const nodes = [];
  const known = Object.create(null);
  const typeFolders = Object.create(null);
  rows.forEach(function(row) {
    if (!row || typeof row.uuid !== 'string' || !HASM_CHAT.UUID_PATTERN.test(row.uuid) ||
        ['EXPERIENCE', 'FACT', 'LINK', 'PERSON'].indexOf(row.entity_type) === -1 || known[row.uuid]) {
      throw new Error('Invalid or duplicate HASM entity in hasm.db.');
    }
    known[row.uuid] = true;
    const expectedPath = row.entity_type + '/' + row.uuid + '/main.md';
    if (row.path !== undefined && row.path !== expectedPath) {
      throw new Error('Invalid HASM entity path for ' + row.uuid);
    }
    if (!typeFolders[row.entity_type]) {
      typeFolders[row.entity_type] = singleHASMChatChild_(root, row.entity_type, true);
    }
    const folder = singleHASMChatChild_(typeFolders[row.entity_type], row.uuid, true);
    const file = singleHASMChatChild_(folder, 'main.md', false);
    if (file.getSize() > HASM_CHAT.MAX_NODE_CHARS * 4) {
      throw new Error('HASM node is too large for chat: ' + row.uuid);
    }
    const markdown = file.getBlob().getDataAsString('UTF-8');
    if (markdown.length > HASM_CHAT.MAX_NODE_CHARS) {
      throw new Error('HASM node exceeds ' + HASM_CHAT.MAX_NODE_CHARS + ' characters: ' + row.uuid);
    }
    nodes.push(parseHASMChatMarkdown_(markdown, row, file.getUrl()));
  });
  edges.forEach(function(edge) {
    if (!edge || !known[edge.from_uuid] || !known[edge.to_uuid] || typeof edge.relation !== 'string') {
      throw new Error('Invalid or dangling HASM graph relation.');
    }
  });
  // LINK nodes can also encode graph endpoints in their own metadata.
  nodes.filter(function(node) { return node.type === 'LINK'; }).forEach(function(node) {
    const from = node.fields.from_uuid;
    const to = node.fields.to_uuid;
    if (from || to) {
      if (!known[from] || !known[to] || typeof node.fields.relation !== 'string') {
        throw new Error('Invalid LINK endpoints for ' + node.uuid);
      }
      edges.push({ from_uuid: from, to_uuid: to, relation: node.fields.relation, link_uuid: node.uuid });
    }
  });
  return { nodes: nodes, edges: edges };
}

function hasmChatModelRows_(database) {
  const tables = [
    { name: 'person', type: 'PERSON', id: 'person_id' },
    { name: 'experience', type: 'EXPERIENCE', id: 'experience_id' },
    { name: 'fact', type: 'FACT', id: 'fact_id' },
    { name: 'link', type: 'LINK', id: 'link_id' }
  ];
  tables.forEach(function(table) {
    if (!Array.isArray(database[table.name])) {
      throw new Error('HASM database is missing the ' + table.name + ' table.');
    }
  });
  const rows = [];
  tables.forEach(function(table) {
    database[table.name].forEach(function(entity) {
      if (!entity || typeof entity !== 'object') {
        throw new Error('Invalid row in HASM ' + table.name + ' table.');
      }
      rows.push({
        uuid: entity[table.id],
        entity_type: table.type,
        path: table.type + '/' + entity[table.id] + '/main.md'
      });
    });
  });
  const metadata = database.sync_metadata || {};
  if (metadata.legacy_entities !== undefined) {
    if (!Array.isArray(metadata.legacy_entities)) {
      throw new Error('HASM legacy entity metadata must be an array.');
    }
    rows.push.apply(rows, metadata.legacy_entities);
  }
  return rows;
}

function hasmChatModelEdges_(database) {
  const edges = [];
  const tables = ['experience_tree', 'fact_experience', 'link', 'link_relation'];
  tables.forEach(function(table) {
    if (!Array.isArray(database[table])) {
      throw new Error('HASM database is missing the ' + table + ' table.');
    }
  });
  database.experience_tree.forEach(function(row) {
    edges.push({ from_uuid: row.parent_id, to_uuid: row.child_id, relation: 'branches_to' });
  });
  database.fact_experience.forEach(function(row) {
    edges.push({ from_uuid: row.experience_id, to_uuid: row.fact_id, relation: 'contains' });
  });
  database.person.forEach(function(row) {
    edges.push({
      from_uuid: row.person_id,
      to_uuid: row.life_experience_id,
      relation: 'owns_life_experience'
    });
  });
  database.link.forEach(function(row) {
    edges.push({
      from_uuid: row.origin_entity_id,
      to_uuid: row.link_id,
      relation: 'originates_from'
    });
    edges.push({
      from_uuid: row.link_id,
      to_uuid: row.target_entity_id,
      relation: row.link_type
    });
  });
  database.link_relation.forEach(function(row) {
    edges.push({ from_uuid: row.link_id, to_uuid: row.related_link_id, relation: 'related_link' });
  });
  const metadata = database.sync_metadata || {};
  if (metadata.legacy_links !== undefined) {
    if (!Array.isArray(metadata.legacy_links)) {
      throw new Error('HASM legacy relation metadata must be an array.');
    }
    metadata.legacy_links.forEach(function(edge) {
      edges.push({
        from_uuid: edge.from_uuid,
        to_uuid: edge.to_uuid,
        relation: edge.relation
      });
    });
  }
  return edges;
}

function putHASMChatCache_(cache, key, value) {
  const encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(value))).getBytes());
  const count = Math.ceil(encoded.length / HASM_CHAT.CACHE_CHUNK_SIZE);
  if (count > HASM_CHAT.MAX_CACHE_CHUNKS) {
    throw new Error('HASM chat data exceeds the session cache budget. Use a smaller curated root.');
  }
  const generation = Utilities.getUuid();
  const entries = {};
  for (let i = 0; i < count; i++) {
    entries[key + ':' + generation + ':' + i] = encoded.slice(
      i * HASM_CHAT.CACHE_CHUNK_SIZE, (i + 1) * HASM_CHAT.CACHE_CHUNK_SIZE);
  }
  cache.putAll(entries, HASM_CHAT.CACHE_SECONDS);
  cache.put(key, JSON.stringify({ generation: generation, count: count }), HASM_CHAT.CACHE_SECONDS);
}

function getHASMChatCache_(cache, key) {
  const raw = cache.get(key);
  if (!raw) {
    return null;
  }
  const manifest = JSON.parse(raw);
  const keys = [];
  for (let i = 0; i < manifest.count; i++) {
    keys.push(key + ':' + manifest.generation + ':' + i);
  }
  const entries = cache.getAll(keys);
  if (keys.some(function(part) { return !entries[part]; })) {
    return null;
  }
  const encoded = keys.map(function(part) { return entries[part]; }).join('');
  return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(encoded))).getDataAsString('UTF-8'));
}
