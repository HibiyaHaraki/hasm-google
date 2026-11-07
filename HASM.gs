function createHASMDatabase_() {
  return {
    schema_version: 2,
    person: [],
    experience: [],
    experience_tree: [],
    fact: [],
    fact_experience: [],
    link: [],
    link_relation: [],
    sync_metadata: {
      source_keys: {},
      assets_by_id: {},
      legacy_entities: [],
      legacy_links: []
    }
  };
}

function loadHASMDatabase_(rootFolder) {
  const files = rootFolder.getFilesByName(HASM.DATABASE_FILE_NAME);
  if (!files.hasNext()) {
    return createHASMDatabase_();
  }
  const file = files.next();
  const database = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  if (database.schema_version === 1 && Array.isArray(database.entities) &&
      Array.isArray(database.links) && database.source_keys) {
    const migrated = createHASMDatabase_();
    migrated.sync_metadata.source_keys = database.source_keys;
    migrated.sync_metadata.assets_by_id = database.assets_by_id || {};
    migrated.sync_metadata.legacy_entities = database.entities;
    migrated.sync_metadata.legacy_links = database.links;
    return migrated;
  }
  if (database.schema_version !== 2 ||
      ['person', 'experience', 'experience_tree', 'fact', 'fact_experience', 'link', 'link_relation']
        .some(function(table) { return !Array.isArray(database[table]); }) ||
      !database.sync_metadata || !database.sync_metadata.source_keys ||
      !database.sync_metadata.assets_by_id ||
      !Array.isArray(database.sync_metadata.legacy_entities) ||
      !Array.isArray(database.sync_metadata.legacy_links)) {
    throw new Error('The existing hasm.db has an unsupported or invalid structure.');
  }
  validateHASMDatabase_(database);
  return database;
}

function saveHASMDatabase_(rootFolder, database) {
  validateHASMDatabase_(database);
  const content = JSON.stringify(database, null, 2);
  const files = rootFolder.getFilesByName(HASM.DATABASE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    rootFolder.createFile(HASM.DATABASE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

function migrateHASMDatabase() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    throw new Error('Another HASM operation is running. Retry the database migration shortly.');
  }
  try {
    const root = getOrCreateHASMRoot_();
    const database = loadHASMDatabase_(root);
    saveHASMDatabase_(root, database);
    console.log('HASM JSON database is now schema_version 2.');
  } finally {
    lock.releaseLock();
  }
}

function validateHASMDatabase_(database) {
  const ids = {
    PERSON: Object.create(null),
    EXPERIENCE: Object.create(null),
    FACT: Object.create(null),
    LINK: Object.create(null)
  };
  const entityTypeTables = Object.create(null);
  entityTypeTables.Person = 'PERSON';
  entityTypeTables.Experience = 'EXPERIENCE';
  entityTypeTables.Fact = 'FACT';
  const allIds = Object.create(null);
  database.person.forEach(function(row) {
    if (!row || !isHASMUuid_(row.person_id) || allIds[row.person_id] || !row.life_experience_id ||
        typeof row.person_name !== 'string' || !row.person_name.trim() ||
        typeof row.person_description !== 'string' || !validSecurityLevel_(row.security_level)) {
      throw new Error('Invalid PERSON row in HASM database.');
    }
    allIds[row.person_id] = true;
    ids.PERSON[row.person_id] = true;
    validateHASMUrls_(row.link);
  });
  database.experience.forEach(function(row) {
    if (!row || !isHASMUuid_(row.experience_id) || allIds[row.experience_id] ||
        typeof row.experience_name !== 'string' || !row.experience_name.trim() ||
        typeof row.experience_description !== 'string' || !validSecurityLevel_(row.security_level)) {
      throw new Error('Invalid EXPERIENCE row in HASM database.');
    }
    allIds[row.experience_id] = true;
    ids.EXPERIENCE[row.experience_id] = true;
    validateHASMUrls_(row.link);
  });
  database.fact.forEach(function(row) {
    if (!row || !isHASMUuid_(row.fact_id) || allIds[row.fact_id] ||
        typeof row.fact_name !== 'string' ||
        !row.fact_name.trim() || typeof row.fact_description !== 'string' ||
        typeof row.occurred_at !== 'string' || typeof row.start_time !== 'string' ||
        typeof row.end_time !== 'string' || !validSecurityLevel_(row.security_level)) {
      throw new Error('Invalid FACT row in HASM database.');
    }
    allIds[row.fact_id] = true;
    ids.FACT[row.fact_id] = true;
    validateHASMUrls_(row.link);
  });
  database.link.forEach(function(row) {
    if (!row || !isHASMUuid_(row.link_id) || allIds[row.link_id] ||
        typeof row.link_type !== 'string' ||
        !row.link_type.trim() || typeof row.link_description !== 'string' ||
        !Object.prototype.hasOwnProperty.call(entityTypeTables, row.origin_entity_type) ||
        !Object.prototype.hasOwnProperty.call(entityTypeTables, row.target_entity_type) ||
        !row.origin_entity_id || !row.target_entity_id || !validSecurityLevel_(row.security_level)) {
      throw new Error('Invalid LINK row in HASM database.');
    }
    allIds[row.link_id] = true;
    ids.LINK[row.link_id] = true;
    validateHASMUrls_(row.link);
  });
  database.person.forEach(function(row) {
    if (!ids.EXPERIENCE[row.life_experience_id]) {
      throw new Error('PERSON life_experience_id does not reference an EXPERIENCE.');
    }
  });
  database.experience_tree.forEach(function(row) {
    if (!row || !ids.EXPERIENCE[row.parent_id] || !ids.EXPERIENCE[row.child_id] ||
        row.parent_id === row.child_id) {
      throw new Error('Invalid EXPERIENCE_TREE relationship in HASM database.');
    }
  });
  database.fact_experience.forEach(function(row) {
    if (!row || !ids.FACT[row.fact_id] || !ids.EXPERIENCE[row.experience_id]) {
      throw new Error('Invalid FACT_EXPERIENCE relationship in HASM database.');
    }
  });
  database.link.forEach(function(row) {
    if (!ids[entityTypeTables[row.origin_entity_type]][row.origin_entity_id] ||
        !ids[entityTypeTables[row.target_entity_type]][row.target_entity_id] ||
        row.origin_entity_id === row.target_entity_id) {
      throw new Error('LINK endpoints must reference distinct existing HASM entities.');
    }
  });
  database.link_relation.forEach(function(row) {
    if (!row || !ids.LINK[row.link_id] || !ids.LINK[row.related_link_id] ||
        row.link_id === row.related_link_id) {
      throw new Error('Invalid LINK_RELATION relationship in HASM database.');
    }
  });
}

function validSecurityLevel_(value) {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

function isHASMUuid_(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validateHASMUrls_(values) {
  if (!Array.isArray(values)) {
    throw new Error('HASM external links must be stored as an array.');
  }
  values.forEach(function(value) {
    if (!isValidHASMUrl_(value)) {
      throw new Error('HASM external links must contain only absolute HTTP(S) URLs without credentials or whitespace.');
    }
  });
}

function getOrCreateHASMRoot_() {
  const folders = DriveApp.getFoldersByName(HASM.ROOT_FOLDER_NAME);
  const root = folders.hasNext() ? folders.next() : DriveApp.createFolder(HASM.ROOT_FOLDER_NAME);
  ['PERSON', 'EXPERIENCE', 'FACT', 'LINK'].forEach(function(entityType) {
    getOrCreateEntityFolder_(root, entityType);
  });
  return root;
}

function getOrCreateEntityFolder_(root, entityType) {
  const folders = root.getFoldersByName(entityType.toUpperCase());
  return folders.hasNext() ? folders.next() : root.createFolder(entityType.toUpperCase());
}

function createHASMEntity_(root, database, entityType, fields, body, urls, timestamp, sourceKey) {
  const externalLinks = uniqueStrings_(urls);
  const uuid = Utilities.getUuid();
  const folder = getOrCreateEntityFolder_(root, entityType).createFolder(uuid);
  const entity = {
    uuid: uuid,
    title: fields.title,
    timestamp: timestamp,
    entity_type: entityType.toUpperCase(),
    link: externalLinks,
    fields: fields,
    body: body,
    path: entityType.toUpperCase() + '/' + uuid + '/main.md'
  };
  const createdFiles = driveBatchCreateEntityFiles_(folder.getId(), renderHASMMarkdown_(entity));
  entity.assets_folder_id = createdFiles.assets;
  if (sourceKey) {
    database.sync_metadata.source_keys[sourceKey] = uuid;
  }
  console.log('    created ' + entity.entity_type + ': ' + String(fields.title || '').substring(0, 80));
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
  const headers = response.getHeaders();
  const contentType = headers['Content-Type'] || headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  const results = parseDriveBatchResponse_(responseText, boundaryMatch ? boundaryMatch[1] : batchBoundary);
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
  if (!Array.isArray(values)) {
    throw new Error('HASM external links must be an array.');
  }
  return values.filter(function(value) {
    if (typeof value !== 'string' || !isValidHASMUrl_(value)) {
      throw new Error('HASM external links must contain only absolute HTTP(S) URLs without credentials or whitespace.');
    }
    if (seen[value]) {
      return false;
    }
    seen[value] = true;
    return true;
  });
}

function isValidHASMUrl_(value) {
  if (typeof value !== 'string' || value !== value.trim() || /\s/.test(value)) {
    return false;
  }
  const match = value.match(/^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?(?:[/?#]|$)/i);
  if (!match || (match[2] && (Number(match[2]) <= 0 || Number(match[2]) > 65535))) {
    return false;
  }
  if (match[1].charAt(0) === '[') {
    return true;
  }
  return match[1].length <= 253 && match[1].split('.').every(function(label) {
    return label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
  });
}

function createHASMEvent_(root, database, records, generated) {
  if (!Array.isArray(records) || !records.length) {
    throw new Error('Cannot create a HASM event without source records.');
  }
  const timestamp = records[0].timestamp;
  const endTime = records[records.length - 1].timestamp;
  const sourceKey = hashSourceIds_(records.map(function(record) { return record.id; }).sort());
  if (database.sync_metadata.source_keys[sourceKey]) {
    return false;
  }
  const urls = uniqueStrings_(records.map(function(record) { return record.url; }).filter(Boolean));
  const experience = generated.experience;
  const experienceEntity = createHASMEntity_(root, database, 'EXPERIENCE', {
    title: experience.title,
    experience_name: experience.title,
    description: experience.description,
    experience_description: experience.description,
    security_level: 0,
    emotion: experience.emotion || '',
    takeaway: experience.takeaway || ''
  }, experience.description, urls, timestamp, sourceKey);
  database.experience.push({
    experience_id: experienceEntity.uuid,
    experience_name: experience.title,
    experience_description: experience.description,
    link: experienceEntity.link,
    security_level: 0
  });

  const entitiesByName = Object.create(null);
  registerHASMEntityName_(entitiesByName, experience.title, {
    entity_type: 'EXPERIENCE',
    entity_id: experienceEntity.uuid
  });
  generated.facts.forEach(function(fact) {
    const entity = createHASMEntity_(root, database, 'FACT', {
      title: fact.title,
      fact_name: fact.title,
      description: fact.description,
      fact_description: fact.description,
      occurred_at: timestamp,
      start_time: timestamp,
      end_time: endTime,
      security_level: 0
    }, fact.description, urls, timestamp, '');
    database.fact.push({
      fact_id: entity.uuid,
      fact_name: fact.title,
      fact_description: fact.description,
      link: entity.link,
      occurred_at: timestamp,
      start_time: timestamp,
      end_time: endTime,
      security_level: 0
    });
    database.fact_experience.push({
      fact_id: entity.uuid,
      experience_id: experienceEntity.uuid
    });
    registerHASMEntityName_(entitiesByName, fact.title, {
      entity_type: 'FACT',
      entity_id: entity.uuid
    });
  });

  generated.people.forEach(function(person) {
    const personKey = person.name.trim().toLocaleLowerCase();
    let personRow = database.person.filter(function(row) {
      return row.person_name.trim().toLocaleLowerCase() === personKey;
    })[0];
    if (!personRow) {
      const legacyPerson = database.sync_metadata.legacy_entities.filter(function(row) {
        return row && row.entity_type === 'PERSON' && typeof row.title === 'string' &&
          row.title.trim().toLocaleLowerCase() === personKey && isHASMUuid_(row.uuid);
      })[0];
      const rootExperienceTitle = person.name + ' life stream';
      const rootExperience = createHASMEntity_(root, database, 'EXPERIENCE', {
        title: rootExperienceTitle,
        experience_name: rootExperienceTitle,
        description: 'Root experience for ' + person.name + '.',
        experience_description: 'Root experience for ' + person.name + '.',
        security_level: 0
      }, 'Root experience for ' + person.name + '.', [], timestamp, '');
      database.experience.push({
        experience_id: rootExperience.uuid,
        experience_name: rootExperienceTitle,
        experience_description: 'Root experience for ' + person.name + '.',
        link: [],
        security_level: 0
      });
      let personId;
      if (legacyPerson) {
        personId = legacyPerson.uuid;
      } else {
        const personEntity = createHASMEntity_(root, database, 'PERSON', {
          title: person.name,
          person_name: person.name,
          person_description: person.description || '',
          life_experience_id: rootExperience.uuid,
          security_level: 0,
          role: person.role || ''
        }, person.description || '', [], timestamp, '');
        personId = personEntity.uuid;
      }
      personRow = {
        person_id: personId,
        life_experience_id: rootExperience.uuid,
        person_name: person.name,
        person_description: person.description || '',
        link: [],
        security_level: 0
      };
      database.person.push(personRow);
      if (legacyPerson) {
        database.sync_metadata.legacy_entities = database.sync_metadata.legacy_entities.filter(function(row) {
          return row.uuid !== legacyPerson.uuid;
        });
      }
    }
    registerHASMEntityName_(entitiesByName, person.name, {
      entity_type: 'PERSON',
      entity_id: personRow.person_id
    });
    addHASMExperienceTree_(database, personRow.life_experience_id, experienceEntity.uuid);
  });

  generated.links.forEach(function(link) {
    const origin = entitiesByName[String(link.from || '').trim().toLocaleLowerCase()];
    const target = entitiesByName[String(link.to || '').trim().toLocaleLowerCase()];
    if (!origin || !target || origin.entity_id === target.entity_id) {
      console.warn('Skipping generated link with unresolved or identical endpoints: ' + JSON.stringify({
        title: link.title, from: link.from, to: link.to
      }));
      return;
    }
    const linkType = link.relation || link.title;
    const entity = createHASMEntity_(root, database, 'LINK', {
      title: link.title,
      link_name: link.title,
      link_type: linkType,
      link_description: link.description || '',
      origin_entity_type: hasmModelEntityType_(origin.entity_type),
      origin_entity_id: origin.entity_id,
      target_entity_type: hasmModelEntityType_(target.entity_type),
      target_entity_id: target.entity_id,
      security_level: 0
    }, link.description || '', urls, timestamp, '');
    database.link.push({
      link_id: entity.uuid,
      link_type: linkType,
      link_description: link.description || '',
      link: entity.link,
      origin_entity_type: hasmModelEntityType_(origin.entity_type),
      origin_entity_id: origin.entity_id,
      target_entity_type: hasmModelEntityType_(target.entity_type),
      target_entity_id: target.entity_id,
      security_level: 0
    });
  });

  records.forEach(function(record) {
    if (!record.assetId || database.sync_metadata.assets_by_id[record.assetId]) {
      return;
    }
    const sourceFile = DriveApp.getFileById(record.assetId);
    const assetFolder = DriveApp.getFolderById(experienceEntity.assets_folder_id);
    const copy = sourceFile.makeCopy(sourceFile.getName(), assetFolder);
    database.sync_metadata.assets_by_id[record.assetId] = copy.getId();
  });
  return true;
}

function registerHASMEntityName_(entitiesByName, name, entity) {
  const key = name.trim().toLocaleLowerCase();
  if (entitiesByName[key] && entitiesByName[key].entity_id !== entity.entity_id) {
    throw new Error('Generated entity names must be distinct for unambiguous LINK endpoints: ' + name);
  }
  entitiesByName[key] = entity;
}

function hasmModelEntityType_(entityType) {
  const names = Object.create(null);
  names.PERSON = 'Person';
  names.EXPERIENCE = 'Experience';
  names.FACT = 'Fact';
  if (!Object.prototype.hasOwnProperty.call(names, entityType)) {
    throw new Error('Unsupported HASM model entity type: ' + entityType);
  }
  return names[entityType];
}

function addHASMExperienceTree_(database, parentId, childId) {
  if (parentId === childId) {
    throw new Error('An EXPERIENCE cannot be its own parent.');
  }
  const exists = database.experience_tree.some(function(row) {
    return row.parent_id === parentId && row.child_id === childId;
  });
  if (!exists) {
    database.experience_tree.push({ parent_id: parentId, child_id: childId });
  }
}

function hashSourceIds_(ids) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ids.join('\n'));
  return digest.map(function(byte) {
    const value = (byte + 256) % 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}
