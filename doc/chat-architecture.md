# HASM conversational coaching

## Components and request flow

- `ChatApp.gs`: `doGet`, session lifecycle and serialized, user-scoped chat requests.
- `ChatData.gs`: read-only Drive traversal, frontmatter parsing and compressed user cache.
- `ChatGemini.gs`: semantic retrieval, graph expansion, mode prompts and output validation.
- `Chat.html`: responsive HTML Service client, asynchronous RPC and safe source rendering.

1. The user chooses a mode and starts a conversation. The server resolves
   `HASM_CHAT_ROOT_FOLDER_ID`, or the unique existing `hasm_root`. It never creates a root.
2. Read the schema-v1 JSON `hasm.db` and resolve each indexed node through
   `TYPE/UUID/main.md`. Do not trust an arbitrary path from metadata. Missing items,
   duplicate UUIDs, mismatched frontmatter and dangling graph edges fail explicitly.
   The database is authoritative: unindexed folders and `assets/` are not scanned.
3. Parse metadata, full Markdown, reflections (`takeaway`, `emotion`, etc.) and
   external `link` references. Missing `link` defaults to `[]`. Read the writer's
   JSON-compatible YAML scalars, native JSON arrays and single-quoted/simple
   scalars. General YAML block scalars, tags, anchors and multiline arrays are
   deliberately unsupported; normalize imported records before use. This is not
   a general YAML parser.
4. Cache the corpus and adjacency edges with `CacheService.getUserCache()`.
   Gzip/base64 data is split into 80,000-character chunks, below the 100 KB item
   limit. A generation manifest is published after chunks; any missing chunk
   invalidates the entire value. CacheService can evict data before its TTL.
5. A random UUID session contains its mode, corpus key and last three completed
   user/assistant turns. A user lock rejects concurrent sends. Sessions are not
   a durable conversation store, and no chat content is written to Drive.
6. On send, Gemini scores batches of up to 20 EXPERIENCE/FACT nodes against the
   challenge and recent history. Every candidate is evaluated, not keyword-filtered.
   Rank all returned matches globally and retain up to five. Expand their one-hop
   relations to at most 15 total nodes, including linked FACT, PERSON and LINK
   records. Preserve relation direction. Explicit `from_uuid`/`to_uuid` LINK
   metadata also adds an edge; the sync writer's title-valued `from`/`to` fields
   remain descriptive, with canonical endpoints supplied by `hasm.db.links`.
7. Generate a mode-specific JSON answer using only the selected evidence.
   Verify section count/order, non-empty text, output size and every inline
   `[uuid]` citation. Unknown, malformed or missing citations (when evidence was
   selected) reject the response. Resolve all citation URLs/titles from Drive,
   never from model-supplied URLs. Only cited nodes appear in the source list.
8. Save history only after successful validation. Return structured sections,
   source references and structural matching rationales. The client renders text
   nodes and anchors, never model HTML.

## Structural retrieval and prompt architecture

The retrieval system prompt separates instructions from JSON data and explicitly
compares **causal structure**: constraints, incentives, stakeholders, uncertainty,
failed attempts, corrective actions, tradeoffs, outcomes and lessons. Shared job
titles or vocabulary alone are not sufficient. Each match includes a rationale
with supporting evidence and differences. The rubric is shared across batches:
0.8-1 means a strongly supported causal analogy; 0.5-0.79 means a useful partial
analogy; weaker matches are omitted. These are model judgments, not calibrated
probabilities. No embeddings, keyword index or external vector service is required.

The generation prompt treats history as context, not evidence, and distinguishes
objective facts from subjective reflections. It prohibits invented metrics,
achievements and recovery narratives. An empty retrieval produces explicit
evidence gaps, focused questions and labeled general suggestions, not a fictional
personal story.

- **Career:** CV bullets, STAR Situation/Task/Action/Result, gaps and next steps.
  Unsupported STAR components must be labeled as missing evidence.
- **Mentorship:** empathy, structural parallel, actions to try, risks and limits.
  Supported failures/recovery inform proposed small experiments and check-ins;
  suggested actions must not be presented as historical facts.

The full prompts are ordinary functions in `ChatGemini.gs` and are tested without
calling Gemini. Prompt boundaries and citation checks reduce risk but cannot
prove semantic entailment or prevent every prompt-injection attempt. Users must
review the original evidence; a valid UUID does not guarantee a true claim.

## Quotas, freshness and limitations

- Corpus/session TTL: 600 seconds. Session writes renew its TTL; the shared corpus
  expires independently. Reload after expiry or eviction. Reload rereads Markdown
  even when `hasm.db` has not changed and resets the UI conversation. Existing
  sessions for the same user/root also see that refreshed corpus.
- Maximum 300 indexed entities, 16,000 characters per Markdown file, and 12 cache
  chunks per stored value. Exceeding a limit is an explicit error, never silent
  truncation. Use a smaller curated HASM root for larger archives.
- Each message costs `ceil((EXPERIENCE + FACT count) / 20) + 1` Gemini calls
  (one generation call even with no matches). Reading the corpus is cached;
  semantic retrieval runs afresh because the challenge/history change.
- A request checks a four-minute work deadline between calls and before generation.
  Apps Script execution/UrlFetch limits, Gemini quotas and individual call latency
  can still terminate work. Requests are synchronous on the server and asynchronous
  in the browser; reduce corpus size if they are slow. There are no automatic
  retries or background triggers that could duplicate charges.
- API HTTP errors, blocked/incomplete responses and invalid JSON/output propagate
  to the UI. API keys are sent in a request header, not a browser payload or URL.
  Chat errors omit raw Gemini error bodies; inspect API/project quotas separately.
- HTML Service `google.script.run` cannot directly stream response chunks. This
  implementation intentionally uses an asynchronous pending state, not simulated
  token streaming. Durable jobs/streaming would require additional infrastructure.

## Deployment and privacy

Use the manifest's **execute as user accessing / only myself** defaults. Do not
deploy as the owner to other users: it could expose the owner's Drive and API
quota. If adapting to multiple users, review OAuth access, root selection and
shared Script Properties first; this project is a personal app, not a tenant
administration system. The existing sync OAuth scopes remain unchanged.

The model receives the user's message, last three turns and all EXPERIENCE/FACT
metadata/Markdown during retrieval. Generation also receives selected graph
neighbors, including PERSON metadata. Do not use records you do not want sent to
the configured Gemini project. Assets and referenced external pages are not
fetched. External source links are displayed only for HTTP(S), and Drive access
permissions are not changed. Conversation data is transient in user cache and
the current browser tab, not persistent chat files. The app does not explicitly
log conversations. Apps Script exception logging can capture parser diagnostics
and metadata in errors; restrict access to execution logs as well as the project.

## Verification

Run `npm test` locally (Node.js; no third-party packages) or run
`runHASMUnitTests` and `runHASMChatUnitTests` in Apps Script. Local integration
tests mock Drive, CacheService, locks and Gemini to verify traversal, batching,
history bounds, isolation, cache eviction and API failures. These tests do not
establish real model quality or verify Google authorization/deployment.

Before production, deploy privately with a small reviewed test root and verify:

1. A challenge about conflicting engineering priorities retrieves a non-technical
   experience about competing stakeholder incentives, not just a keyword match.
2. A record sharing the challenge's job title but not its causal structure ranks
   below a supported structural analogy.
3. A junior colleague's blocker maps to a supported failure/corrective action;
   the guidance acknowledges differences and proposes testable next steps.
4. Absent metrics or outcomes remain evidence gaps in CV/STAR output.
5. Each citation opens the correct Drive `main.md`, and external references match
   metadata; empty/irrelevant roots yield no invented personal claims.
6. Editing only Markdown becomes visible after reload; an expired session gives
   an actionable error. Check mobile layout and keyboard-only operation.
