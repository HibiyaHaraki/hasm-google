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

`hasm.db` is UTF-8 JSON with `schema_version`, `entities`, `links`, `source_keys`, `people_by_key`, and `assets_by_id`. The `links` array is the relational junction table: `{ "from_uuid": "...", "to_uuid": "...", "relation": "..." }`.

Every `main.md` has common YAML frontmatter `uuid`, `title`, `timestamp`, `entity_type`, and `link`. `link` is a YAML string containing JSON-encoded external URL references; absent references are represented by the string `"[]"`. Entity-specific model output is stored as additional frontmatter fields and a Markdown description body.

## API behavior

Gemini is called through `UrlFetchApp` using the key in Script Properties. Non-2xx responses, invalid JSON, and malformed generated entities fail explicitly and are visible in execution logs. The script does not silently substitute generated content.
