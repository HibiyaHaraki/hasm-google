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
    const groups = groupHASMRecords_(records, config.groupWindowMinutes);
    let processed = 0;
    let index = 0;
    for (; index < groups.length; index++) {
      if (processed >= config.maxEventsPerRun || Date.now() >= deadline) {
        break;
      }
      const group = groups[index];
      const sourceKey = hashSourceIds_(group.map(function(record) { return record.id; }).sort());
      if (database.source_keys[sourceKey]) {
        continue;
      }
      const generated = generateHASMEvent_(group, config);
      createHASMEvent_(root, database, group, generated);
      saveHASMDatabase_(root, database);
      processed++;
    }
    const pendingGroups = groups.slice(index).some(function(group) {
      const key = hashSourceIds_(group.map(function(record) { return record.id; }).sort());
      return !database.source_keys[key];
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

function groupHASMRecords_(records, windowMinutes) {
  const sorted = records.filter(function(record) {
    return record.timestamp && !isNaN(new Date(record.timestamp).getTime());
  }).sort(function(left, right) {
    return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
  });
  const groups = [];
  let current = [];
  let groupStart = 0;
  const windowMs = windowMinutes * 60 * 1000;
  sorted.forEach(function(record) {
    const time = new Date(record.timestamp).getTime();
    if (!current.length || time - groupStart <= windowMs) {
      if (!current.length) {
        groupStart = time;
      }
      current.push(record);
    } else {
      groups.push(current);
      current = [record];
      groupStart = time;
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
