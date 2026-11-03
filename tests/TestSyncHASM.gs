function runHASMUnitTests() {
  testGroupHASMRecords();
  testNormalizeMapsSegment();
  testNormalizeCurrentMapsSegment();
  testNormalizeCurrentMapsActivity();
  testHASMModelDatabaseSchema();
  testLegacyHASMDatabaseMigration();
  testRenderHASMMarkdown();
  testHASMDatabaseValidation();
  testValidateGeneratedEvent();
  testParseDriveBatchResponse();
  console.log('All HASM unit tests passed.');
}

function testNormalizeCurrentMapsSegment() {
  const result = normalizeMapsSegment_({
    startTime: '2025-01-01T10:00:00Z',
    endTime: '2025-01-01T10:30:00Z',
    visit: {
      topCandidate: {
        semanticType: 'INFERRED_HOME',
        placeLocation: { address: 'Some address', latLng: '35.0, 139.0' }
      }
    }
  }, 1);
  assertEqual_(result.timestamp, '2025-01-01T10:00:00Z', 'current Maps timestamp');
  assertEqual_(result.title, 'Some address', 'current Maps place');
  assert_(result.text.indexOf('35.0, 139.0') !== -1, 'current Maps coordinates');
}

function testNormalizeCurrentMapsActivity() {
  const result = normalizeMapsSegment_({
    startTime: '2025-01-01T10:00:00Z',
    activity: {
      start: { latLng: '35.0, 139.0' },
      distanceMeters: 1200,
      topCandidate: { type: 'WALKING' }
    }
  }, 2);
  assertEqual_(result.title, 'WALKING', 'current Maps activity');
  assert_(result.text.indexOf('Distance: 1200') !== -1, 'current Maps activity distance');
}

function testGroupHASMRecords() {
  const records = [
    { id: 'b', timestamp: '2025-01-01T10:30:00Z' },
    { id: 'a', timestamp: '2025-01-01T10:00:00Z' },
    { id: 'c', timestamp: '2025-01-01T11:00:00Z' }
  ];
  const groups = groupHASMRecords_(records, 45);
  assertEqual_(groups.length, 2, 'group count');
  assertEqual_(groups[0].length, 2, 'first group size');
  assertEqual_(groups[0][0].id, 'a', 'sort order');
}

function testNormalizeMapsSegment() {
  const result = normalizeMapsSegment_({
    placeVisit: {
      startTime: '2025-01-01T10:00:00Z',
      endTime: '2025-01-01T11:00:00Z',
      location: { name: 'Example place', latitudeE7: 350000000, longitudeE7: 1390000000 }
    }
  }, 0);
  assertEqual_(result.title, 'Example place', 'Maps title');
  assertEqual_(result.timestamp, '2025-01-01T10:00:00Z', 'Maps timestamp');
  assert_(result.text.indexOf('35, 139') !== -1, 'Maps coordinates');
}

function testRenderHASMMarkdown() {
  const markdown = renderHASMMarkdown_({
    uuid: 'uuid-1',
    title: 'A "quoted" title',
    timestamp: '2025-01-01T10:00:00.000Z',
    entity_type: 'EXPERIENCE',
    link: [],
    fields: { description: 'A line\nwith text', emotion: '' },
    body: 'Summary'
  });
  assert_(markdown.indexOf('entity_type: "EXPERIENCE"') !== -1, 'entity type frontmatter');
  assert_(markdown.indexOf('link: []') !== -1, 'link is a JSON array');
  assert_(markdown.indexOf('title: "A \\"quoted\\" title"') !== -1, 'quoted YAML scalar');
}

function testHASMModelDatabaseSchema() {
  const database = createHASMDatabase_();
  assertEqual_(database.schema_version, 2, 'model database version');
  ['person', 'experience', 'experience_tree', 'fact', 'fact_experience', 'link', 'link_relation']
    .forEach(function(table) {
      assert_(Array.isArray(database[table]), table + ' table array');
    });
  assert_(database.sync_metadata.source_keys, 'sync metadata');
}

function testLegacyHASMDatabaseMigration() {
  const legacy = {
    schema_version: 1,
    entities: [{ uuid: 'legacy-id', entity_type: 'FACT', title: 'Legacy', path: 'FACT/legacy-id/main.md' }],
    links: [{ from_uuid: 'legacy-id', to_uuid: 'other-id', relation: 'supports' }],
    source_keys: { source: 'legacy-id' },
    assets_by_id: { asset: 'copy' }
  };
  const legacyFile = { getBlob: function() {
    return { getDataAsString: function() { return JSON.stringify(legacy); } };
  } };
  const root = { getFilesByName: function() {
    return { hasNext: function() { return true; }, next: function() { return legacyFile; } };
  } };
  const migrated = loadHASMDatabase_(root);
  assertEqual_(migrated.schema_version, 2, 'legacy database version');
  assertEqual_(migrated.sync_metadata.source_keys.source, 'legacy-id', 'preserved source keys');
  assertEqual_(migrated.sync_metadata.legacy_entities.length, 1, 'preserved legacy entities');
  assertEqual_(migrated.sync_metadata.legacy_links.length, 1, 'preserved legacy relations');
  assertEqual_(migrated.sync_metadata.assets_by_id.asset, 'copy', 'preserved asset IDs');
}

function testHASMDatabaseValidation() {
  const database = createHASMDatabase_();
  database.experience.push({
    experience_id: '00000000-0000-4000-8000-000000000001', experience_name: 'Life', experience_description: '',
    link: [], security_level: 0
  });
  database.person.push({
    person_id: '00000000-0000-4000-8000-000000000002',
    life_experience_id: '00000000-0000-4000-8000-000000000001', person_name: 'Test',
    person_description: '', link: [], security_level: 0
  });
  validateHASMDatabase_(database);
  database.person[0].life_experience_id = '00000000-0000-4000-8000-000000000003';
  let error;
  try {
    validateHASMDatabase_(database);
  } catch (caught) {
    error = caught;
  }
  assert_(error && error.message.indexOf('life_experience_id') !== -1, 'reject dangling life experience');
}

function testValidateGeneratedEvent() {
  const event = {
    experience: { title: 'Test', description: 'Test description' },
    facts: [],
    people: [],
    links: []
  };
  validateGeneratedEvent_(event);
  assertEqual_(event.facts.length, 0, 'facts array');
}

function testParseDriveBatchResponse() {
  const boundary = 'batch_test';
  const response = [
    '--batch_test',
    'Content-Type: application/http',
    'Content-ID: <response-assets>',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '{"id":"assets-id"}',
    '--batch_test',
    'Content-Type: application/http',
    'Content-ID: <response-main>',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '{"id":"main-id"}',
    '--batch_test--',
    ''
  ].join('\r\n');
  const parsed = parseDriveBatchResponse_(response, boundary);
  assertEqual_(parsed.assets, 'assets-id', 'assets batch response');
  assertEqual_(parsed.main, 'main-id', 'main batch response');
}

function assert_(condition, label) {
  if (!condition) {
    throw new Error('Assertion failed: ' + label);
  }
}

function assertEqual_(actual, expected, label) {
  assert_(actual === expected, label + ' (expected ' + expected + ', got ' + actual + ')');
}
