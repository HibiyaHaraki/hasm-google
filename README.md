# HASM Google Apps Script sync and coaching

This project collects date-bounded Gmail, Google Maps Timeline JSON, and Drive image records, groups nearby activity, uses Gemini to structure the event, and writes HASM entities to Google Drive.

It also provides an HTML Service coaching chat: structural experience matching,
career CV/STAR narratives, mentorship guidance, and citations to original HASM
records and their source references.

## Setup

1. Create a standalone Apps Script project and add the `.gs` files, `Chat.html`, and `appsscript.json` from this folder (or push them with clasp).
2. Set the Script Properties listed in [doc/api-spec.md](doc/api-spec.md), including the exact ISO start/end range and `GEMINI_API_KEY`.
3. Optionally add the Drive file ID of a Maps Timeline JSON export and a Drive folder ID containing imported image files.
4. Run `syncHASM` once and grant Gmail, Drive, external request, and trigger permissions when prompted.
5. Run `runHASMUnitTests` to execute the standalone tests.

## Coaching web app

1. Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in Script Properties.
   Chat alone does not require the sync date range.
2. Set `HASM_CHAT_ROOT_FOLDER_ID` to your existing HASM Drive folder, or ensure
   exactly one folder named `hasm_root` is accessible.
3. Deploy as a **Web app**, executing as **user accessing the web app**, accessible
   to **only myself** (the manifest defaults). Authorize access and open its URL.
   Do not share an owner-executed deployment.
4. Choose Career or Mentorship, click **Start / reload records**, and send a
   challenge. Responses arrive asynchronously; inspect numbered citations and
   the Sources disclosure. Reload to see edited Drive records or recover from
   cache expiry. Only the last three completed turns are remembered.

For clasp, run `clasp login`, then `clasp create --type standalone --title "HASM"`
in this directory (or `clasp clone SCRIPT_ID` in a separate directory and copy its
ignored `.clasp.json` here), then `clasp push`. Configure Script Properties and
deployment access in the Apps Script editor. `.claspignore` uploads only GAS,
the chat HTML and the manifest, including GAS tests; it excludes local tooling
and documentation. Do not commit generated credentials or `.clasp.json`.

See [chat architecture and prompt design](doc/chat-architecture.md) and
[UI specification](doc/ui-design.md) for privacy, quotas, supported frontmatter,
limits and deployment verification. HTML Service uses asynchronous calls, not
token streaming. Chat currently supports curated roots of up to 300 entities;
oversized data and malformed records fail explicitly.

## Tests

Run `npm test` with Node.js to execute both GAS unit suites, mocked service
integration tests and client-script syntax checks. No dependency installation
is needed. In Apps Script, run `runHASMUnitTests` and `runHASMChatUnitTests`
(include the `.gs` files from `tests/`). Real Drive authorization and Gemini
quality require a private deployed smoke test.

The script sends selected Gmail text and source summaries to Gemini for structuring. Read [doc/architecture.md](doc/architecture.md#source-limitations-and-privacy) before enabling it. Entity file/folder metadata is created with a Drive API batch request, followed by the Markdown upload; each event and index is persisted in a bounded unit.

## Security

Do not commit `.clasp.json`, credentials, or API keys. Store the Gemini key only in Script Properties, restrict script editors, and rotate the key if exposed.

Sending a chat message sends HASM metadata/Markdown and recent conversation to
Gemini. Review the privacy notice and use only records you intend to share with
that API. Assets and external pages are not fetched. AI output and structurally
valid citations still require human fact-checking.
