# Chat UI specification

## Layout

`Chat.html` is a dependency-free HTML Service page with a centered, 900 px maximum
content column. The header introduces HASM Coach; a settings card contains the
mode selector, start/reload button, privacy notice and live status/error area.
Conversation cards distinguish user messages from coaching responses. A labeled
composer sits below the conversation. Controls stack on narrow screens.

Career responses display CV bullets and four STAR components, followed by gaps.
Mentorship responses display empathy, structural parallel, actions and limits.
Section headings remain fixed in English for the response contract; prompts ask
the model to write section content in the user's language.

## Interaction states

| State | Behavior |
|---|---|
| Initial | Choose a mode; composer disabled until records load. |
| Loading | Disable controls; announce Drive indexing. |
| Ready | Show record count and ten-minute cache guidance; focus composer. |
| Pending | Append user card, lock controls, mark conversation busy, announce matching/generation. |
| Success | Render sections and citations, clear draft, focus composer. |
| Error | Announce explicit error, restore controls and preserve draft; failed user card is removed. |
| Mode change | Clear visible conversation/session; require a new start. Preserve draft. |
| Reload | Force reread of records, then clear visible conversation on success. Preserve draft. |

Submission uses the Send button or Ctrl/Cmd+Enter; ordinary Enter inserts a
newline. Messages are limited to 4,000 characters. Browser calls use
`google.script.run` success/failure handlers, so the page remains responsive.
There is no cancel button or fake streaming: the server call must complete.
Do not blindly retry after a transport failure, since server completion is
unknown and another call may incur charges.

## Citations and source references

Inline model `[uuid]` citations become numbered anchors opening the original
Drive Markdown in a new tab. Accessible labels/tooltips identify the source
title. A collapsible ordered source list shows node type, title, UUID and original
HTTP(S) external references. The numbering is deduplicated across the answer.
A second disclosure shows AI-generated structural match rationales and UUIDs;
these are explanations, not verified historical facts.

Use `textContent`/text nodes for all model, record and user strings. Never inject
HTML or render arbitrary Markdown. URLs come from server-resolved records and
are checked for HTTP(S) again in the browser. New-tab links use
`noopener noreferrer`. No scripts, fonts or styles are loaded from third-party
CDNs.

## Accessibility

Use native labeled controls, semantic headings/cards, visible keyboard focus,
minimum 44 px button height, a polite live status, an alert for failures and
`aria-busy` for the conversation. Long UUIDs and messages wrap without horizontal
scrolling. Response arrival scrolls without animation; the full generated
response is not automatically read aloud as a giant live-region update.
