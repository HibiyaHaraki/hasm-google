function syncHASM() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another HASM sync is already running.');
    return;
  }
  const started = Date.now();
  try {
    const config = getHASMConfig_();
    const deadline = started + HASM.MAX_RUNTIME_MS;
    const root = getOrCreateHASMRoot_();
    const database = loadHASMDatabase_(root);
    const collection = collectHASMRecords_(config, deadline);
    const records = collection.records;
    const groups = groupHASMRecords_(records, config.groupWindowMinutes, config.maxRecordsPerGroup, HASM.MAX_GROUP_TEXT_CHARS);
    const todo = groups.filter(function(group) {
      return !database.sync_metadata.source_keys[hashSourceIds_(group.map(function(record) { return record.id; }).sort())];
    }).length;
    console.log('[HASM] Collected ' + records.length + ' records in ' + groups.length + ' groups; ' +
      todo + ' new groups to process (up to ' + config.maxEventsPerRun + ' this run).');
    let processed = 0;
    let index = 0;
    for (; index < groups.length; index++) {
      if (processed >= config.maxEventsPerRun || Date.now() >= deadline) {
        break;
      }
      const group = groups[index];
      const sourceKey = hashSourceIds_(group.map(function(record) { return record.id; }).sort());
      if (database.sync_metadata.source_keys[sourceKey]) {
        continue;
      }
      console.log('[HASM] Event ' + (processed + 1) + ' (group ' + (index + 1) + '/' + groups.length + ', ' +
        group.length + ' records, ' + group[0].timestamp + '): asking Gemini...');
      let generated;
      try {
        generated = generateHASMEvent_(group, config);
      } catch (error) {
        if (error.hasmTransient) {
          console.warn('[HASM] Gemini is unavailable; stopping this run and scheduling a retry. ' + error.message);
          break;
        }
        throw error;
      }
      console.log('[HASM] Gemini returned ' + generated.facts.length + ' facts, ' + generated.people.length +
        ' people, ' + generated.links.length + ' links; writing to Drive...');
      createHASMEvent_(root, database, group, generated);
      saveHASMDatabase_(root, database);
      processed++;
      console.log('[HASM] Saved event ' + processed + ' (' + (todo - processed) + ' groups remaining).');
      Utilities.sleep(HASM.GEMINI_PACING_MS);
    }
    const pendingGroups = groups.slice(index).some(function(group) {
      const key = hashSourceIds_(group.map(function(record) { return record.id; }).sort());
      return !database.sync_metadata.source_keys[key];
    });
    const pageComplete = collection.gmailPage.complete && !collection.interrupted;
    if (pageComplete && !pendingGroups) {
      const properties = PropertiesService.getScriptProperties();
      if (collection.gmailPage.hasMore) {
        properties.setProperties({
          HASM_GMAIL_CURSOR_QUERY: collection.gmailPage.query,
          HASM_GMAIL_CURSOR: String(collection.gmailPage.offset + collection.gmailPage.count)
        });
      } else {
        properties.deleteProperty('HASM_GMAIL_CURSOR');
        properties.deleteProperty('HASM_GMAIL_CURSOR_QUERY');
      }
    }
    if (pendingGroups || !pageComplete || collection.gmailPage.hasMore) {
      scheduleHASMContinuation_();
    } else {
      clearHASMContinuation_();
    }
    console.log(JSON.stringify({ records: records.length, groups: groups.length, processed: processed }));
  } finally {
    lock.releaseLock();
  }
}

function groupHASMRecords_(records, windowMinutes, maxRecords, maxChars) {
  const sorted = records.filter(function(record) {
    return record.timestamp && !isNaN(new Date(record.timestamp).getTime());
  }).sort(function(left, right) {
    return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
  });
  const groups = [];
  let current = [];
  let groupStart = 0;
  let chars = 0;
  const windowMs = windowMinutes * 60 * 1000;
  sorted.forEach(function(record) {
    const time = new Date(record.timestamp).getTime();
    const size = String(record.text || '').length;
    const fits = (!maxRecords || current.length < maxRecords) && (!maxChars || chars + size <= maxChars);
    if (!current.length || (time - groupStart <= windowMs && fits)) {
      if (!current.length) {
        groupStart = time;
        chars = 0;
      }
      current.push(record);
      chars += size;
    } else {
      groups.push(current);
      current = [record];
      groupStart = time;
      chars = size;
    }
  });
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function scheduleHASMContinuation_() {
  const properties = PropertiesService.getScriptProperties();
  const existingId = properties.getProperty(HASM.CONTINUATION_TRIGGER_ID_PROPERTY);
  const triggers = ScriptApp.getProjectTriggers();
  const existing = triggers.some(function(trigger) {
    return trigger.getUniqueId() === existingId;
  });
  if (existing) {
    return;
  }
  properties.deleteProperty(HASM.CONTINUATION_TRIGGER_ID_PROPERTY);
  const trigger = ScriptApp.newTrigger(HASM.CONTINUATION_HANDLER).timeBased().after(60 * 1000).create();
  properties.setProperty(HASM.CONTINUATION_TRIGGER_ID_PROPERTY, trigger.getUniqueId());
}

function clearHASMContinuation_() {
  const properties = PropertiesService.getScriptProperties();
  const triggerId = properties.getProperty(HASM.CONTINUATION_TRIGGER_ID_PROPERTY);
  if (!triggerId) {
    return;
  }
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  properties.deleteProperty(HASM.CONTINUATION_TRIGGER_ID_PROPERTY);
}
