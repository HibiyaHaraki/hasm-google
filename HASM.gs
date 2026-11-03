function createHASMDatabase_() {
  return {
    schema_version: 1,
    entities: [],
    links: [],
    source_keys: {},
    people_by_key: {},
    assets_by_id: {}
  };
}

function loadHASMDatabase_(rootFolder) {
  const files = rootFolder.getFilesByName(HASM.DATABASE_FILE_NAME);
  if (!files.hasNext()) {
    return createHASMDatabase_();
  }
  const file = files.next();
  const database = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  if (database.schema_version !== 1 || !Array.isArray(database.entities) ||
      !Array.isArray(database.links) || !database.source_keys) {
    throw new Error('The existing hasm.db has an unsupported or invalid structure.');
  }
  database.people_by_key = database.people_by_key || {};
  database.assets_by_id = database.assets_by_id || {};
  return database;
}

function saveHASMDatabase_(rootFolder, database) {
  const content = JSON.stringify(database, null, 2);
  const files = rootFolder.getFilesByName(HASM.DATABASE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    rootFolder.createFile(HASM.DATABASE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

function getOrCreateHASMRoot_() {
  const folders = DriveApp.getFoldersByName(HASM.ROOT_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(HASM.ROOT_FOLDER_NAME);
}

function getOrCreateEntityFolder_(root, entityType) {
  const folders = root.getFoldersByName(entityType.toUpperCase());
  return folders.hasNext() ? folders.next() : root.createFolder(entityType.toUpperCase());
}

function createHASMEntity_(root, database, entityType, fields, body, urls, timestamp, sourceKey) {
  const uuid = Utilities.getUuid();
  const folder = getOrCreateEntityFolder_(root, entityType).createFolder(uuid);
  const entity = {
    uuid: uuid,
    title: fields.title,
    timestamp: timestamp,
    entity_type: entityType.toUpperCase(),
    link: JSON.stringify(uniqueStrings_(urls)),
    fields: fields,
    body: body,
    path: entityType.toUpperCase() + '/' + uuid + '/main.md'
  };
  const createdFiles = driveBatchCreateEntityFiles_(folder.getId(), renderHASMMarkdown_(entity));
  entity.assets_folder_id = createdFiles.assets;
  database.entities.push({
    uuid: uuid,
    entity_type: entity.entity_type,
    title: entity.title,
    timestamp: timestamp,
    path: entity.path
  });
  if (sourceKey) {
    database.source_keys[sourceKey] = uuid;
  }
  return entity;
}

function driveBatchCreateEntityFiles_(parentFolderId, markdown) {
  const batchBoundary = 'hasm_batch_' + Utilities.getUuid().replace(/-/g, '');
  const assetMetadata = JSON.stringify({
    name: 'assets',
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId]
  });
  const markdownMetadata = JSON.stringify({
    name: 'main.md',
    mimeType: 'text/markdown',
    parents: [parentFolderId]
  });
  const requests = [
    '--' + batchBoundary,
    'Content-Type: application/http',
    'Content-ID: <assets>',
    '',
    'POST /drive/v3/files HTTP/1.1',
    'Content-Type: application/json; charset=UTF-8',
    '',
    assetMetadata,
    '--' + batchBoundary,
    'Content-Type: application/http',
    'Content-ID: <main>',
    '',
    'POST /drive/v3/files HTTP/1.1',
    'Content-Type: application/json; charset=UTF-8',
    '',
    markdownMetadata,
    '--' + batchBoundary + '--',
    ''
  ].join('\r\n');
  const response = UrlFetchApp.fetch('https://www.googleapis.com/batch/drive/v3', {
    method: 'post',
    contentType: 'multipart/mixed; boundary=' + batchBoundary,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: requests,
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Drive batch write failed (' + status + '): ' + responseText.substring(0, 1000));
  }
  const results = parseDriveBatchResponse_(responseText, batchBoundary);
  if (!results.assets || !results.main) {
    throw new Error('Drive batch write did not return both assets and main.md file IDs.');
  }
  const upload = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(results.main) + '?uploadType=media',
    {
      method: 'patch',
      contentType: 'text/markdown; charset=UTF-8',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: markdown,
      muteHttpExceptions: true
    }
  );
  const uploadStatus = upload.getResponseCode();
  if (uploadStatus < 200 || uploadStatus >= 300) {
    throw new Error('Drive main.md upload failed (' + uploadStatus + '): ' + upload.getContentText().substring(0, 1000));
  }
  return results;
}

function parseDriveBatchResponse_(responseText, boundary) {
  const results = {};
  responseText.split('--' + boundary).forEach(function(part) {
    const idMatch = part.match(/Content-ID:\s*<response-(assets|main)>/i);
    if (!idMatch) {
      return;
    }
    const statusMatch = part.match(/HTTP\/1\.[01]\s+(\d+)/i);
    if (!statusMatch || Number(statusMatch[1]) < 200 || Number(statusMatch[1]) >= 300) {
      throw new Error('Drive batch subrequest failed: ' + part.substring(0, 1000));
    }
    const separator = part.lastIndexOf('\r\n\r\n');
    if (separator < 0) {
      throw new Error('Drive batch response was missing a JSON body.');
    }
    const result = JSON.parse(part.substring(separator + 4).trim());
    if (!result.id) {
      throw new Error('Drive batch subrequest returned no file ID.');
    }
    results[idMatch[1].toLowerCase()] = result.id;
  });
  return results;
}

function renderHASMMarkdown_(entity) {
  const frontmatter = [
    '---',
    'uuid: ' + yamlScalar_(entity.uuid),
    'title: ' + yamlScalar_(entity.title),
    'timestamp: ' + yamlScalar_(entity.timestamp),
    'entity_type: ' + yamlScalar_(entity.entity_type),
    'link: ' + yamlScalar_(entity.link)
  ];
  Object.keys(entity.fields).sort().forEach(function(key) {
    if (['uuid', 'title', 'timestamp', 'entity_type', 'link'].indexOf(key) === -1) {
      frontmatter.push(key + ': ' + yamlScalar_(entity.fields[key]));
    }
  });
  return frontmatter.join('\n') + '\n---\n\n' + String(entity.body || '').trim() + '\n';
}

function yamlScalar_(value) {
  return JSON.stringify(value === undefined || value === null ? '' : value);
}

function uniqueStrings_(values) {
  const seen = Object.create(null);
  return (values || []).filter(function(value) {
    if (typeof value !== 'string' || !value || seen[value]) {
      return false;
    }
    seen[value] = true;
    return true;
  });
}

function addHASMRelation_(database, fromUuid, toUuid, relation) {
  if (!fromUuid || !toUuid || fromUuid === toUuid) {
    return;
  }
  const exists = database.links.some(function(link) {
    return link.from_uuid === fromUuid && link.to_uuid === toUuid && link.relation === relation;
  });
  if (!exists) {
    database.links.push({ from_uuid: fromUuid, to_uuid: toUuid, relation: relation });
  }
}

function createHASMEvent_(root, database, records, generated) {
  const timestamp = records[0].timestamp;
  const sourceKey = hashSourceIds_(records.map(function(record) { return record.id; }).sort());
  if (database.source_keys[sourceKey]) {
    return false;
  }
  const urls = records.map(function(record) { return record.url; }).filter(String);
  const experience = generated.experience;
  const experienceEntity = createHASMEntity_(root, database, 'EXPERIENCE', {
    title: experience.title,
    description: experience.description,
    emotion: experience.emotion || '',
    takeaway: experience.takeaway || ''
  }, experience.description, urls, timestamp, sourceKey);

  const entitiesByName = Object.create(null);
  entitiesByName[experience.title.trim().toLocaleLowerCase()] = experienceEntity.uuid;
  generated.facts.forEach(function(fact) {
    const entity = createHASMEntity_(root, database, 'FACT', {
      title: fact.title,
      description: fact.description
    }, fact.description, urls, timestamp, '');
    entitiesByName[fact.title.trim().toLocaleLowerCase()] = entity.uuid;
    addHASMRelation_(database, experienceEntity.uuid, entity.uuid, 'includes');
  });

  generated.people.forEach(function(person) {
    const personKey = person.name.trim().toLocaleLowerCase();
    const storedPersonKey = 'name:' + personKey;
    let personUuid = database.people_by_key[storedPersonKey];
    if (!personUuid) {
      const entity = createHASMEntity_(root, database, 'PERSON', {
        title: person.name,
        name: person.name,
        role: person.role || '',
        description: person.description || ''
      }, person.description || '', [], timestamp, '');
      personUuid = entity.uuid;
      database.people_by_key[storedPersonKey] = personUuid;
    }
    entitiesByName[personKey] = personUuid;
    addHASMRelation_(database, experienceEntity.uuid, personUuid, 'involves');
  });

  generated.links.forEach(function(link) {
    const entity = createHASMEntity_(root, database, 'LINK', {
      title: link.title,
      description: link.description || '',
      from: link.from || '',
      to: link.to || '',
      relation: link.relation || ''
    }, link.description || '', urls, timestamp, '');
    addHASMRelation_(database, experienceEntity.uuid, entity.uuid, 'connected_by');
    const fromUuid = entitiesByName[String(link.from || '').trim().toLocaleLowerCase()];
    const toUuid = entitiesByName[String(link.to || '').trim().toLocaleLowerCase()];
    if (fromUuid && toUuid) {
      addHASMRelation_(database, fromUuid, toUuid, link.relation || link.title);
    }
  });

  records.forEach(function(record) {
    if (!record.assetId || database.assets_by_id[record.assetId]) {
      return;
    }
    const sourceFile = DriveApp.getFileById(record.assetId);
    const assetFolder = DriveApp.getFolderById(experienceEntity.assets_folder_id);
    const copy = sourceFile.makeCopy(sourceFile.getName(), assetFolder);
    database.assets_by_id[record.assetId] = copy.getId();
  });
  return true;
}

function hashSourceIds_(ids) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ids.join('\n'));
  return digest.map(function(byte) {
    const value = (byte + 256) % 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}
