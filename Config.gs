const HASM = Object.freeze({
  ROOT_FOLDER_NAME: 'hasm_root',
  DATABASE_FILE_NAME: 'hasm.db',
  DEFAULT_MODEL: 'gemini-3.5-flash-lite',
  DEFAULT_GROUP_WINDOW_MINUTES: 1440,
  DEFAULT_MAX_RECORDS_PER_GROUP: 25,
  MAX_GROUP_TEXT_CHARS: 30000,
  MAX_RUNTIME_MS: 240000,
  MAX_EVENTS_PER_RUN: 30,
  MAX_GMAIL_THREADS_PER_PAGE: 50,
  MAX_SOURCE_TEXT_LENGTH: 2500,
  MAX_DRIVE_DOCS_PER_RUN: 200,
  GEMINI_MAX_ATTEMPTS: 4,
  GEMINI_RETRY_BASE_DELAY_MS: 5000,
  GEMINI_PACING_MS: 3000,
  CONTINUATION_HANDLER: 'syncHASM',
  CONTINUATION_TRIGGER_ID_PROPERTY: 'HASM_CONTINUATION_TRIGGER_ID'
});

function getHASMConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const start = requiredProperty_(properties, 'HASM_START_ISO');
  const end = requiredProperty_(properties, 'HASM_END_ISO');
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate >= endDate) {
    throw new Error('HASM_START_ISO and HASM_END_ISO must be valid ISO timestamps with start before end.');
  }

  const apiKey = requiredProperty_(properties, 'GEMINI_API_KEY');
  return {
    startDate: startDate,
    endDate: endDate,
    apiKey: apiKey,
    model: properties.getProperty('GEMINI_MODEL') || HASM.DEFAULT_MODEL,
    groupWindowMinutes: positiveNumberProperty_(properties, 'HASM_GROUP_WINDOW_MINUTES', HASM.DEFAULT_GROUP_WINDOW_MINUTES),
    maxRecordsPerGroup: positiveNumberProperty_(properties, 'HASM_MAX_RECORDS_PER_GROUP', HASM.DEFAULT_MAX_RECORDS_PER_GROUP),
    mapsExportFileId: properties.getProperty('HASM_MAPS_EXPORT_FILE_ID') || '',
    mediaFolderId: properties.getProperty('HASM_MEDIA_FOLDER_ID') || '',
    docsFolderId: properties.getProperty('HASM_DRIVE_DOCS_FOLDER_ID') || '',
    calendarIds: (properties.getProperty('HASM_CALENDAR_IDS') || '').split(',').map(function(id) {
      return id.trim();
    }).filter(String),
    gmailQuery: properties.getProperty('HASM_GMAIL_QUERY') || '',
    maxEventsPerRun: positiveNumberProperty_(properties, 'HASM_MAX_EVENTS_PER_RUN', HASM.MAX_EVENTS_PER_RUN)
  };
}

function requiredProperty_(properties, key) {
  const value = properties.getProperty(key);
  if (!value || !value.trim()) {
    throw new Error('Missing Script Property: ' + key);
  }
  return value.trim();
}

function positiveNumberProperty_(properties, key, fallback) {
  const value = properties.getProperty(key);
  if (!value) {
    return fallback;
  }
  const number = Number(value);
  if (!isFinite(number) || number <= 0) {
    throw new Error(key + ' must be a positive number.');
  }
  return number;
}

function getDateRangeQuery_(config) {
  const start = new Date(Date.UTC(
    config.startDate.getUTCFullYear(),
    config.startDate.getUTCMonth(),
    config.startDate.getUTCDate() - 1
  ));
  const end = new Date(Date.UTC(
    config.endDate.getUTCFullYear(),
    config.endDate.getUTCMonth(),
    config.endDate.getUTCDate() + 1
  ));
  const after = Utilities.formatDate(start, 'GMT', 'yyyy/MM/dd');
  const before = Utilities.formatDate(end, 'GMT', 'yyyy/MM/dd');
  return ['after:' + after, 'before:' + before, config.gmailQuery].filter(String).join(' ');
}
