# Configuration and data specification

## Script Properties

Set these in **Project Settings → Script Properties**:

| Property | Required | Meaning |
|---|---:|---|
| `HASM_START_ISO` | sync only | Inclusive range start, ISO timestamp (for example `2025-01-01T00:00:00+09:00`) |
| `HASM_END_ISO` | sync only | Exclusive range end, ISO timestamp |
| `GEMINI_API_KEY` | yes | Gemini API key; never put it in source control |
| `GEMINI_MODEL` | no | Model name, defaults to `gemini-2.5-flash` |
| `HASM_GROUP_WINDOW_MINUTES` | no | Group window, defaults to 45 |
| `HASM_MAX_EVENTS_PER_RUN` | no | New groups processed per invocation, defaults to 30 |
| `HASM_GMAIL_QUERY` | no | Additional Gmail search terms |
| `HASM_MAPS_EXPORT_FILE_ID` | no | Drive file ID for a Maps Timeline JSON export |
| `HASM_MEDIA_FOLDER_ID` | no | Drive folder ID containing image files |
| `HASM_CHAT_ROOT_FOLDER_ID` | no | Existing HASM root folder for chat; otherwise require a unique accessible `hasm_root` |

## Entry points

- `syncHASM()` performs a locked sync and schedules continuations when needed.
- `migrateHASMDatabase()` upgrades the persisted JSON index to schema version 2
  while retaining schema-version-1 rows for compatibility.
- `runHASMUnitTests()` runs service-independent parser, grouping, and schema tests.
- `doGet()` serves the coaching UI.
- `startHASMChat(mode, refresh)` validates `career`/`mentorship`, loads the user
  corpus cache, and returns `{sessionId, mode, nodeCount, cacheSeconds}`. A boolean
  `true` refresh forces a Drive reread. No Gemini request occurs at startup.
- `sendHASMChatMessage(sessionId, message)` validates a nonblank message of up to
  4,000 characters and returns the structured response below. Sessions are
  user-scoped, ephemeral UUID tokens; one send per user can run at a time.
- `runHASMChatUnitTests()` verifies chat prompts, metadata, graph context and
  citation/output contracts; `npm test` adds mocked service integration tests.

### Chat response

```json
{
  "mode": "mentorship",
  "sections": [
    {
      "heading": "Empathy",
      "text": "Plain text; supported personal claims use [node-uuid] citations.",
      "citations": ["node-uuid"]
    }
  ],
  "sources": [
    {
      "uuid": "node-uuid",
      "title": "Original title",
      "type": "EXPERIENCE",
      "url": "https://drive.google.com/file/d/file-id/view",
      "links": ["https://example.com/original-reference"]
    }
  ],
  "matches": [
    { "uuid": "node-uuid", "rationale": "Shared causal pattern and important differences." }
  ]
}
```

The abbreviated example uses placeholders; real citations must be UUIDs from the
selected evidence. Career returns exactly six sections: `CV bullets`,
`STAR - Situation`, `STAR - Task`, `STAR - Action`, `STAR - Result`, and
`Gaps and next steps`. Mentorship returns four: `Empathy`, `Structural parallel`,
`Actions to try`, and `Risks and limits`. Sources contain only cited nodes,
deduplicated in appearance order. Errors propagate through the RPC failure
handler; no success-shaped fallback is returned. See
[chat-architecture.md](chat-architecture.md) for cache and API limits.

## Input records

Each internal source record has `id`, ISO `timestamp`, `kind`, `title`, `text`, `url`, and optional Drive `assetId`. Gmail messages and Maps segments are filtered by the configured date range. Image files are filtered by Drive creation date.

Maps imports accept an array named `timelineObjects`, `semanticSegments`, or `timeline`. Each segment's time is read from `startTime`, `startTimestamp`, `start_time`, or `timestamp`; Google Takeout `placeVisit` and `activitySegment` fields are recognized.

## Persisted schema

`hasm.db` is UTF-8 JSON with `schema_version: 2` and table-named arrays:
`person`, `experience`, `experience_tree`, `fact`, `fact_experience`, `link`,
and `link_relation`. Entity rows use the column names from the HASM model; the
three relationship arrays use the corresponding junction-table columns.
`sync_metadata` holds source deduplication keys, copied asset IDs, and preserved
schema-version-1 rows for backwards-compatible reads. Each PERSON references
its root EXPERIENCE through `life_experience_id`; generated links store typed
origin and target IDs with `Person`, `Experience`, or `Fact` entity-type values.
Run `migrateHASMDatabase()` once in Apps Script to upgrade an existing
schema-version-1 JSON index; the migration preserves legacy entity/relation rows
without treating them as new model rows.

Entity Markdown keeps the common YAML fields `uuid`, `title`, `timestamp`,
`entity_type`, and `link`, alongside model-specific fields and a description
body. `link` is a native JSON/YAML array of external URL strings (including an
empty `[]`), not a JSON-encoded string. URL entries must be absolute HTTP(S)
URLs without credentials or whitespace.

Apps Script cannot create a native SQLite database. To open a synced/downloaded
`hasm_root` in HASM desktop, convert its JSON file to the native SQLite
`main.db` with Python's standard-library SQLite support:

```powershell
python tools\export_sqlite.py C:\path\to\hasm_root
```

The exporter writes `<hasm_root>\main.db`, refuses to overwrite an existing
file unless `--overwrite` is explicitly supplied, and validates model
relationships and Markdown files. The SQLite database includes the HASM model
tables and junction tables, plus the compatibility columns used by the desktop
app's current readers. See `README.md` for the expected local folder workflow.

## API behavior

Gemini is called through `UrlFetchApp` using the key in Script Properties. Non-2xx responses, invalid JSON, and malformed generated entities fail explicitly and are visible in execution logs. The script does not silently substitute generated content.
