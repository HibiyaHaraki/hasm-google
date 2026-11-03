function collectHASMRecords_(config, deadline) {
  const records = [];
  const gmailPage = collectGmailRecords_(config, deadline, records);
  if (Date.now() < deadline) {
    collectMapsRecords_(config, records);
  }
  if (Date.now() < deadline) {
    collectDriveMediaRecords_(config, deadline, records);
  }
  return { records: records, gmailPage: gmailPage, interrupted: Date.now() >= deadline };
}

function collectGmailRecords_(config, deadline, records) {
  const properties = PropertiesService.getScriptProperties();
  const query = getDateRangeQuery_(config);
  const savedQuery = properties.getProperty('HASM_GMAIL_CURSOR_QUERY');
  const offset = savedQuery === query ? Number(properties.getProperty('HASM_GMAIL_CURSOR') || 0) : 0;
  const threads = GmailApp.search(query, offset, HASM.MAX_GMAIL_THREADS_PER_PAGE);
  for (let threadIndex = 0; threadIndex < threads.length && Date.now() < deadline; threadIndex++) {
    const messages = threads[threadIndex].getMessages();
    for (let messageIndex = 0; messageIndex < messages.length && Date.now() < deadline; messageIndex++) {
      const message = messages[messageIndex];
      const date = message.getDate();
      if (date >= config.startDate && date < config.endDate) {
        const body = stripHtml_(message.getPlainBody() || message.getBody());
        records.push({
          id: 'gmail:' + message.getId(),
          timestamp: date.toISOString(),
          kind: 'email',
          title: message.getSubject() || '(no subject)',
          text: [
            'From: ' + message.getFrom(),
            'To: ' + message.getTo(),
            'Subject: ' + (message.getSubject() || ''),
            body.substring(0, HASM.MAX_SOURCE_TEXT_LENGTH)
          ].join('\n'),
          url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(message.getId()),
          assetId: ''
        });
      }
    }
  }
  return {
    query: query,
    offset: offset,
    count: threads.length,
    hasMore: threads.length === HASM.MAX_GMAIL_THREADS_PER_PAGE,
    complete: Date.now() < deadline
  };
}

function collectMapsRecords_(config, records) {
  if (!config.mapsExportFileId) {
    return;
  }
  const file = DriveApp.getFileById(config.mapsExportFileId);
  const exportData = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  const segments = exportData.timelineObjects || exportData.semanticSegments || exportData.timeline || [];
  if (!Array.isArray(segments)) {
    throw new Error('The Maps export must contain a timelineObjects, semanticSegments, or timeline array.');
  }

  segments.forEach(function(segment, index) {
    const parsed = normalizeMapsSegment_(segment, index);
    if (!parsed) {
      return;
    }
    const date = new Date(parsed.timestamp);
    if (date >= config.startDate && date < config.endDate) {
      records.push({
        id: 'maps:' + parsed.id,
        timestamp: date.toISOString(),
        kind: 'location',
        title: parsed.title,
        text: parsed.text.substring(0, HASM.MAX_SOURCE_TEXT_LENGTH),
        url: file.getUrl(),
        assetId: ''
      });
    }
  });
}

function normalizeMapsSegment_(segment, index) {
  const visit = segment.placeVisit || segment.visit || null;
  const activity = segment.activitySegment || segment.activity || null;
  const data = visit || activity || segment;
  const timestamp = data.startTime || data.startTimestamp || data.start_time || data.timestamp ||
    segment.startTime || segment.startTimestamp || segment.start_time || segment.timestamp;
  if (!timestamp) {
    return null;
  }
  const candidate = (visit && visit.topCandidate) || (activity && activity.topCandidate) || {};
  const place = candidate.placeLocation || data.location || data.place || data.startLocation ||
    (data.start && data.start.location) || {};
  const title = place.name || place.address || candidate.semanticType || candidate.type || data.activityType ||
    (typeof data.activity === 'string' ? data.activity : '') || 'Timeline segment';
  const end = data.endTime || data.endTimestamp || data.end_time ||
    segment.endTime || segment.endTimestamp || segment.end_time || '';
  const coordinates = place.latitudeE7 !== undefined && place.longitudeE7 !== undefined
    ? (place.latitudeE7 / 1e7) + ', ' + (place.longitudeE7 / 1e7)
    : place.latLng || (data.start && data.start.latLng) ||
      [place.latitude, place.longitude].filter(function(value) { return value !== undefined; }).join(', ');
  const activityType = data.activityType || candidate.semanticType || candidate.type || '';
  const details = [
    'Place/activity: ' + title,
    end ? 'End: ' + end : '',
    coordinates ? 'Coordinates: ' + coordinates : '',
    activityType ? 'Activity type: ' + activityType : '',
    data.distance || data.distanceMeters ? 'Distance: ' + (data.distance || data.distanceMeters) : ''
  ].filter(String).join('\n');
  return {
    id: String(data.segmentId || data.id || index),
    timestamp: timestamp,
    title: String(title),
    text: details
  };
}

function collectDriveMediaRecords_(config, deadline, records) {
  if (!config.mediaFolderId) {
    return;
  }
  const folder = DriveApp.getFolderById(config.mediaFolderId);
  const files = folder.getFiles();
  while (files.hasNext() && Date.now() < deadline) {
    const file = files.next();
    if (!/^image\//.test(file.getMimeType())) {
      continue;
    }
    const date = file.getDateCreated();
    if (date < config.startDate || date >= config.endDate) {
      continue;
    }
    records.push({
      id: 'drive:' + file.getId(),
      timestamp: date.toISOString(),
      kind: 'photo',
      title: file.getName(),
      text: 'Image file: ' + file.getName() + '\nCreated in Drive: ' + date.toISOString(),
      url: file.getUrl(),
      assetId: file.getId()
    });
  }
}

function stripHtml_(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
