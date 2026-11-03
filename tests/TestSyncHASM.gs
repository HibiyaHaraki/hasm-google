function runHASMUnitTests() {
  testGroupHASMRecords();
  testNormalizeMapsSegment();
  testNormalizeCurrentMapsSegment();
  testNormalizeCurrentMapsActivity();
  testRenderHASMMarkdown();
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
    link: '[]',
    fields: { description: 'A line\nwith text', emotion: '' },
    body: 'Summary'
  });
  assert_(markdown.indexOf('entity_type: "EXPERIENCE"') !== -1, 'entity type frontmatter');
  assert_(markdown.indexOf('link: "[]"') !== -1, 'link is a JSON string');
  assert_(markdown.indexOf('title: "A \\"quoted\\" title"') !== -1, 'quoted YAML scalar');
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
