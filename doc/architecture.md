# HASM GAS architecture

## Components

- `Sources.gs` reads date-bounded Gmail messages, a user-selected Google Maps Timeline JSON export, and images from a user-selected Drive folder.
- `Sync.gs` serializes runs with a script lock, clusters records using a fixed-from-first-record time window, and schedules a one-minute continuation trigger for bounded work.
- `Gemini.gs` sends each new event group to the configured Gemini model and validates the returned structured JSON before persistence.
- `HASM.gs` writes entity folders and `main.md` files, copies referenced images into an experience's `assets/`, and maintains the JSON relational index named `hasm.db`.
- `ChatApp.gs`, `ChatData.gs`, `ChatGemini.gs`, and `Chat.html` add read-only
  conversational coaching over that same index. See
  [chat-architecture.md](chat-architecture.md) for retrieval, prompts, user cache,
  citations and privacy, and [ui-design.md](ui-design.md) for interaction states.

## Drive layout

`hasm_root/` contains `hasm.db` and one directory per entity type. Each entity directory contains a UUID-named folder with `main.md` and `assets/`. Entity frontmatter uses JSON-compatible YAML scalars; `link` is a YAML string whose value is a JSON array, for example `"[]"`.

`hasm.db` is JSON rather than SQLite. Apps Script has no built-in SQLite storage, so this file contains entity rows, junction rows (`links`), source-key deduplication, person identity keys, and copied asset IDs. New entity files are created before the index is updated; a run is protected from concurrent execution but Drive does not provide a multi-file transaction.

## Grouping and identity

Records are sorted chronologically and grouped when each record is within the configured interval from the first record in that group. A SHA-256 key over sorted source IDs makes a group idempotent. People are reused by lower-cased generated name. Review or merge names in `hasm.db` if two distinct people share a name.

## Runtime and quotas

Each run stops processing groups after the configured event count or its four-minute work deadline. Gmail pages use a persisted offset and schedule continuation triggers. Group processing persists the index after each event so an interrupted run can resume without repeating completed groups. Trigger quotas and Apps Script daily service quotas still apply; inspect Apps Script execution logs and rerun after quota errors.

The entity's `main.md` file and `assets/` directory metadata are created in a two-request Drive API batch; the Markdown body is then uploaded to the created file. Entity folders, image copies, and the index are persisted in bounded units, with the index written after each event. This avoids retaining an unbounded write queue in memory. The script avoids copying the same source image more than once.

## Source limitations and privacy

- Gmail collection reads subject, sender, recipient, and plain-text body for messages inside the configured time range.
- Maps Timeline is not exposed as a general Apps Script API. Supply a JSON export stored in Drive; legacy `timelineObjects` and `semanticSegments` arrays are supported.
- Photos are imported as image files from a Drive folder, such as a folder populated with a Google Photos Takeout export. The script uses Drive file creation time as its timestamp; that can differ from original capture time.
- Event text (including selected Gmail content) is sent to the configured Gemini API when processing a new group. Configure only an API key/project you trust, restrict access to the script project, and avoid using this integration for content you do not want sent to Gemini.

See [api-spec.md](./api-spec.md) for properties and data formats.
