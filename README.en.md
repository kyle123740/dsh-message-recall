[简体中文](./README.md) | **English**

# dsh-message-recall

> **What it is for: deleting an AI reply you don't want, or a prompt you already sent by mistake.**

Add **Recall / Delete** to *every single message* in a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) conversation. Hover any message row and a compact action cluster appears at its corner.

```
your prompt     [ Recall ]  [ Delete ]  [ Delete onward ]
AI answer                    [ Delete ]  [ Delete onward ]
tool row                     [ Delete ]  [ Delete onward ]
```

- **In place** — no fork, no new session, no window switch.
- **Really gone** — the removed content leaves both the **model context** and the **transcript**, and stays gone across reloads and restarts.
- **Log-safe** — the DSH session log is append-only; this plugin uses the same mechanism as official compaction (see *How it works*).

## The three actions

| Action | Applies to | What it does |
| --- | --- | --- |
| **Recall** | only messages **you** sent (including steering inserts sent mid-run) | The message leaves the model context and the transcript, and its **original text is dropped back into the composer** so you can edit and resend. It leaves no trace in the conversation. |
| **Delete** | any message (AI answers and tool rows included) | Deleting an AI answer also removes **the tool results of that step** — one step is one model call plus the tool executions it requested, and half-removing it would break the provider's call/result pairing on the next request. Clicking a tool row resolves back to the answer that owns it. Destructive: **two clicks** to confirm. |
| **Delete onward** | any message | Truncates the conversation from that message to the end, in place. |

## Compatibility

| | |
| --- | --- |
| **Tested** | the **DSH 2.0 desktop** (0.2.0-rc.1 — checked against its bundled core: the session format stays v4 and the `surfaceOp` contract is unchanged); also the 0.1.7 line (core `0.1.7-rc.2`, peers `0.1.7-alpha.2`), Node 22.23 |
| **Declared floor** | `dsh >= 0.1.7-alpha.1` (in `package.json` → `dsh.engines.dsh`, which the host enforces at install time) |
| **Unverified** | 0.1.6 and older. Not "known broken" — never tried, so not allowed |

Check your own version:

```bash
dsh --version
```

Host interfaces this plugin leans on. If something breaks after a DSH upgrade, start here:

| Interface | Used for | Availability |
| --- | --- | --- |
| `Session.append("user/message", …, { surfaceOp: { op: "replace", … }, sourceEventSeqs })` | writing the tombstone | dsh-session 0.1.x onward (the same mechanism official compaction uses) |
| `isReplacementSurfaceEvent`, subpath `@deepseek-ai/dsh-session/surface` | telling a replacement apart | same |
| `agent.runMaintenance` | locking against a step in flight | dsh-agent 0.1.x |
| `webServer.register({ kind: "exact" })` | the HTTP route | dsh-host-webserver |
| seat `conversation.input.overlay` | the headless client mount | dsh-client-ui-conversation 0.1.7 |
| DOM markers `data-chat-flow` / `-key` / `-kind` / `data-chat-turn` | decorating and hiding rows | 0.1.x (`data-chat-turn` has been relied on by community plugins since rc.6) |
| `ctx.sessions.binding(id).eventSource` | reading tombstones | the 0.1.7 face; the code falls back to `sessions.get(id)` for the older one |

One honest cross-instance note: the plugin's peer packages and the host core **may be different module instances** (on the machine this was built on, a 0.1.7-rc.2 core runs against 0.1.7-alpha.2 packages). That is safe here only because the plugin touches structured data — `createUserMessage` returns a plain frozen object and surface validation goes through JSON, not `instanceof`. If your install reports a peer conflict, don't force `engines` wider: run `npm test` first and see whether the interfaces are still there.

## Install

From the DSH built-in terminal (or any terminal with `dsh`):

```bash
# desktop profile
dsh plugin --profile desktop add github:kyle123740/dsh-message-recall

# web profile
dsh plugin --profile web add github:kyle123740/dsh-message-recall
```

Pin a version for a reproducible install:

```bash
dsh plugin --profile desktop add github:kyle123740/dsh-message-recall#v0.1.7
```

Then **restart that profile once** (the Host half needs a fresh import) and reload the UI (the Client half is fetched by the page). Toggles live under *Settings → Plugins*, or:

```bash
dsh plugin --profile desktop disable dsh-message-recall
dsh plugin --profile desktop enable  dsh-message-recall
```

> A plugin runs with the privileges of your DSH process and may execute code at install time. Read the source and the licence before you install.

### Uninstall

```bash
dsh plugin --profile desktop remove dsh-message-recall
```

Nothing dangles: a tombstone is an ordinary log event, so uninstalling simply stops the hiding (the removed content reappears) and the session stays readable.

## What a deletion leaves in the transcript

**Nothing.** Recall and delete insert no placeholder and no notice — the row is simply gone from the transcript, as if it had never been sent. That is the 0.1.6 behaviour change: earlier versions kept an inline line in place (“Deleted this message and everything after it · preview”), which was visual noise *and* left a fragment of the text you wanted gone sitting in the conversation.

The trade-off: the UI can no longer show you what was removed. The text is not destroyed — it stays in the session log (`$DSH_HOME/sessions/<project>/<session-id>/session.v4.jsonl.zstd`, append-only), and the repo ships read-only scripts for it:

```bash
node scripts/explain-session.mjs <log-path>   # tombstones, the ranges they cover, what is inside/after them
node scripts/scan-replace.mjs <sessions-root> # find which sessions contain tombstones (HAS-TOMBSTONES)
```

## How it works

1. Resolve the message's position in the current **surface** (the model-visible context).
2. Append one `user/message` tombstone whose content is a **non-empty placeholder** (`content: [{ type: "text", text: "[已撤回]" }]` — see below for why it must not be empty), carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` plus `sourceEventSeqs: [shadowed seqs]`.
3. The surface is the single source of derived model history (`Session.deriveMessages`), so the shadowed content **is not sent on the next request**.
4. The original events stay in the log. Reopening the session replays `foldSurface(events)` and lands on exactly the same surface — deleted content does not come back to life.

### ⚠️ The v4 durable format refuses `source.kind: "plugin"` (the silent data loss fixed in 0.1.3)

The single most useful lesson in this repo: **getting the surface replacement right does not mean it reaches disk.**

Straight from `dsh-session-format-v3-to-v4`:

```js
if (typeof value["kind"] !== "string" || value["kind"].length === 0 || value["kind"] === "plugin")
    throw new SessionFormatError("format v4 message requires a producer-owned source kind");
```

`source.kind` must be a **producer-owned** kind (`user` / `model` / `tool` / `compact-checkpoint` …); `"plugin"` is explicitly refused. v0.1.0–0.1.2 wrote exactly that — `kind: "plugin"` plus `plugin: "message-recall"` — so:

1. the event appended fine to the in-memory log (`Session.append` does not check this), the UI received it and hid the matching rows;
2. at flush time the persistence encoder threw for the **whole batch** → nothing was written;
3. after a restart the log was rebuilt from disk → the deletion was **gone**, and the deleted content was back in the transcript **and in the model context**.

That is the "works when I click it, comes back after a restart" symptom. Since v0.1.3 the tombstone declares `kind: "user"` (it is a user-role message, and `user/message` is **not** required to sit inside an open turn/step in v4, so appending it after `turn/end` is legal) while the plugin's identity rides on `producer: "message-recall"`. The client accepts both shapes, so a stale tombstone already in a page keeps working.

Pinned by [scripts/verify-persistence.mjs](scripts/verify-persistence.mjs): it writes the tombstone through the **real** `@deepseek-ai/dsh-session-persistence-jsonl` backend into a temp root, flushes, reads it back from disk, and asserts that every event round-trips, the tombstone is on disk, the replace semantics survive, the replayed surface equals the live one, and a reopened Session no longer derives the deleted text — plus a negative check that `kind: "plugin"` is refused.

Two details worth knowing, both learned the hard way:

**A tombstone's content must be non-empty, or strict upstreams reject the whole request with a 400.** Earlier versions wrote `content: []`, on the strength of `if (message.role === "user" && content.length === 0) continue;` in the `dsh-llm-deepseek` encoder. That is **one adapter's** behaviour, though: the multi-provider `dsh-llm-pi-ai` does not skip — its `textOnlyContext` sends every non-system/assistant/tool message verbatim as `{ role: "user", content: flattenText(message) }`, so an empty block array becomes `content: ""` on the wire. Strict OpenAI-compatible gateways then reject the **entire request**: measured against SenseAudio (`api.senseaudio.cn`, model `deepseek-v4.1-flash`):

```json
{"is_bifrost_error":false,"status_code":400,"error":{"type":"invalid_request_error","code":"invalid_request_error",
 "message":"messages: Validation error: message content cannot be empty [...]"}}
```

(`content: []` yields `message content parts cannot be empty` instead; `content: " "` / `"\n"` / any text returns 200, and empty content on assistant or tool messages is let through.) DeepSeek's own route and TokenRhythm happen to tolerate empty content, which is why the trap only fires on other routes — it looks like "the same session 400s on a SenseAudio model and works again when I switch back". The tombstone therefore now writes `content: [{ type: "text", text: "[已撤回]" }]`: non-empty, negligible context, still invisible in the UI (a surface-replacement node is not an append-surface event), and hiding is still keyed only on `source.producer` plus the replace range, never on this text. Pinned by `no user message projects empty content` in [scripts/verify.mjs](scripts/verify.mjs).

> Note: this fixes **newly written** tombstones only. Empty tombstones (`content: []`) already on disk still make their sessions fail on strict upstreams — keep those sessions on a route that tolerates empty content, or do the recall/delete work in a fresh session.

**The surface is not the transcript.** `dsh-session` says so out loud: the surface deliberately shadows replaced ranges, because it is the *model* view; a human transcript needs append-origin events, otherwise one replacement would silently erase rows the user already read. So removing something from the model context does **not** remove the row. The hiding is derived client-side from the tombstone's own `source.removed`:

- a single recall/delete hides exactly that span (including log-only rows interleaved inside it);
- *delete onward* hides everything from the target up to the tombstone event — `turn-error`, “retried model request”, the turn action bar all go with it — while **content you send afterwards is untouched**;
- because the state is derived from the durable log, reloads, restarts, and tombstones created before you even installed the plugin all behave identically. Hidden rows carry `data-mcr-hidden`, so only rows this plugin hid get restored — the shipped `hidden` attribute is never touched.

The UI half shadows no shipped renderer. It mounts headlessly into `conversation.input.overlay` (a session-scoped seat) and decorates rows through the official flow markers (`[data-chat-flow]`, `data-chat-flow-key`, `data-chat-flow-kind`). **A row is decorated only when its key resolves to a durable message in this Session's Chat store** — so a different conversation open in the Sidebar gets no buttons and cannot be targeted by mistake.

## Limits and notes

- **Not while the Agent runs**: no buttons appear, and hitting the endpoint directly still goes through `agent.runMaintenance`, which answers `423 AGENT_BUSY` immediately rather than quietly queueing.
- After a whole turn is removed, that turn may be left with only its action bar (projected from `turn/start`/`turn/end`, which are log-only). Those orphan bars are hidden too. A turn that still has content keeps its bar.
- History already folded by **compaction** cannot be removed message by message; the plugin reports “this step is interleaved (likely compacted)” instead of half-doing it.
- The system prompt (surface node 0) can never be recalled or deleted.
- **Recall/delete is not undoable.** The original text remains in the log (recoverable by hand from the session log), but it is gone from the transcript and the model context.
- Only the current Session's rows are handled. Subagent windows show the buttons too, and they act on the Session actually open there.

## HTTP interface

For further development. A plain exact route on `webServer`, no Typert involved:

```
POST /dsh-message-recall
Content-Type: application/json

{ "sessionId": "session-…", "action": "recall" | "delete" | "deleteFrom",
  "seq": 42 }            // or "messageId": "…"

{ "sessionId": "session-…", "action": "migrate" }   # repair legacy empty tombstones; no target
```

Every reply is `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.

| code | HTTP | meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | missing target or unknown action |
| `AGENT_BUSY` | 423 | that Session's Agent has active work |
| `SESSION_NOT_LIVE` | 409 | no live Agent for that Session (open it first) |
| `TARGET_NOT_FOUND` | 409 | not on the current surface (already removed, compacted, or not yet durable) |
| `NOT_A_USER_MESSAGE` | 409 | tried to recall a message you did not send |
| `NOT_DELETABLE` | 409 | the target is the system prompt |
| `SPAN_NOT_CONTIGUOUS` | 409 | the step is interleaved and cannot be removed atomically |

## Development

```bash
npm install            # pulls the peerDependencies (dsh-session / dsh-llm)
node scripts/verify.mjs              # Host: tombstones, step expansion, truncation, guards on a real dsh-session + HTTP end to end
node scripts/verify-persistence.mjs  # Persistence: round trip through the real JSONL backend (write → flush → read from disk → replay)
node scripts/verify-client.mjs       # Client: a hand-built DOM covering decoration, two-click confirm, error copy, row hiding, locale switch
npm test                             # all three
```

`verify-persistence.mjs` is not optional: **it is the only test that can prove "still deleted after a restart".** The 0.1.0–0.1.2 bug passed the other two suites perfectly — everything was correct in memory, it just never reached disk.

### Support scripts (read-only, no DSH needed)

A session log is a container of concatenated zstd frames, so plain gunzip only yields the first frame. That is why the repo carries its own decoder plus a few tools built on it — this is what produced the only hard evidence in the 0.1.3 silent-data-loss hunt:

```bash
# One session: which ranges a tombstone replaced and what sits inside/after them.
# --rows loads the REAL client bundle and uses the plugin's own shadowRanges to
# report which rows the UI should keep and which it should hide.
node scripts/explain-session.mjs "<session-dir>/session.v4.jsonl.zstd" --rows

# Recent-session overview: title, event count, failed turns, tombstone count —
# enough to match a screenshot to the log it came from.
node scripts/list-sessions.mjs "$DSH_HOME/sessions" --hours 6

# Which sessions contain tombstones at all
node scripts/scan-replace.mjs "$DSH_HOME/sessions" --hours 24

# The decoder itself, and a check that it consumed the file to its last byte
node scripts/read-session-log.mjs "<session-dir>/session.v4.jsonl.zstd"
node scripts/verify-decoder.mjs "<session-dir>/session.v4.jsonl.zstd"
```

### Read-only diagnostic endpoint

For live troubleshooting, one read action that needs no live Agent and reads the log **on disk**:

```bash
curl -s -X POST http://127.0.0.1:19387/dsh-message-recall \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-…","action":"inspect"}'
```

It returns `{ live, disk }` summaries: event count, `maxSeq`, every replace event (with `plugin`/`op`/`sourceEventSeqs`), and the per-seq type stream. Comparing "in memory" against "on disk" is what isolated this bug. Each tombstone also carries `legacy: true/false`, so you can see at a glance how many still have the old empty content.

### Repairing legacy empty tombstones (`migrate`)

Older builds wrote tombstones as `content: []`. Those **already on disk** still make strict upstreams reject the whole request with a 400 (see the end of “How it works”), and fixing new tombstones alone does not rescue an old Session. A repair needs the Session **open in the UI** (otherwise `SESSION_NOT_LIVE`):

```bash
curl -s -X POST http://127.0.0.1:19387/dsh-message-recall \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-…","action":"migrate"}'
# → {"ok":true,"value":{"action":"migrate","migrated":3}}
```

Or type nothing at all: **recall or delete anything in that Session** — every operation heals the legacy tombstones on the way past, and reports `migrated: N` in its reply.

The repair appends a fresh tombstone whose replace span is the legacy node itself: the empty node leaves the surface, the new node carries the same placeholder plus the **legacy `removed` list verbatim**, so the Client derives exactly the same hiding as before, and the log is still append-only. Idempotent — a second run answers `migrated: 0`. Covered by the `legacy repair` section of `scripts/verify.mjs`.

### The last-line guard (on by default)

`migrate` fixes the **log**, but it needs the Session open first. So the plugin also listens on the `agent/pre-step` waterfall: before a request leaves, the final message list is scanned and **any user message with blank content** (`[]`, `""`, or only empty text blocks) is given the placeholder in flight. As a result

- Sessions that were never migrated no longer 400 either;
- blank messages from any other producer are covered too;
- only the `user` role is touched — gateways already accept blank assistant/tool content, and rewriting an assistant message would break the pi-ai replay state, which validates its block count.

When it fires, the Host logs a warning that also points at the un-migrated tombstones. The guard is a **runtime safety net that writes nothing**; `migrate` is the **durable cleanup** — rely on the guard day to day and run `migrate` on a Session once you see the warning. Turn it off with:

```yaml
- id: message-recall
  name: dsh-message-recall
  config:
    emptyContentGuard: false
```

The two most valuable assertions in `verify.mjs`:

- `foldSurface(events).nodes === session.surface.nodes` — replay matches the live surface exactly, which is what guarantees “it stays gone after a restart”;
- `handleRecallRequest` driven against a real `Session`, checking the 200/405/409/415/423 envelopes.

One trap when iterating: **the Host reads `lib/client.js` into memory at mount time**, so editing the file alone does not change what the page downloads — disable + enable the plugin (or restart), then reload. A build stamp is logged on load for exactly this reason: `[message-recall] client bundle <BUILD>`.

### Which build is the server actually sending

Arguing about which copy the page runs is easy; here is how to settle it. The Host serves plugin clients through a combo route:

```
GET /plugins/??dsh-message-recall/client.js&rev=<rev>
```

`rev` is the first 12 hex chars of `sha1("plugin-artifact" \0 len:mtimeMs len:ctimeMs len:size)` (`artifactRevision` in `dsh-client-modules`) — file metadata only, contents are never hashed. So "I edited the file but the page did not change" has two completely different causes: the Host has not re-read it (rev still old), or the page has not reloaded (rev is new, the browser holds the old one). Compute the rev from the file's `mtimeMs`/`ctimeMs`/`size`, fetch that URL, and read `const BUILD = "…"` out of the response — compare it with the stamp the page logged and you know which side to fix.

### When something looks wrong

Run this in the page console:

```js
JSON.stringify(window.__MCR_DEBUG__, null, 1)
```

It is the snapshot left by the last sync pass and answers three questions directly: did the tombstones come back from the log (`tombstones`, with `startSeq/endSeq/removed`), what durable seq did each row resolve to (`rows[].anchor`), and was it judged shadowed (`shadowed`). Paste it into an issue and the cause is usually obvious at a glance.

**The authority for what is hidden is the tombstone's own `surfaceOp.startSeq/endSeq`**, not the plugin's custom fields on `source` — a history page is a re-encoded projection of the log, and custom fields are exactly the kind of thing that can move under you. Early builds trusted `source.removed` alone, which produced the very confusing "it worked when I clicked it, but the content came back after a restart" — a bug living only on the reload path. Fixed in v0.1.1, with a regression test that feeds a tombstone whose `source` carries nothing but the plugin identity.

### Layout

```
lib/main.js                Host: route + tombstone writer + inspect
lib/client.js              Client: hand-written window.__ModuleLoader__ bundle, no build step
cordis.patch.yml           registers the message-recall row
scripts/verify*.mjs        offline checks (Host / persistence / Client)
scripts/explain-session.mjs one session: tombstone ranges + expected visible rows (--rows)
scripts/list-sessions.mjs   recent-session overview (title / events / failed turns / tombstones)
scripts/scan-replace.mjs    find tombstones across every stored session
scripts/read-session-log.mjs / verify-decoder.mjs   multi-frame zstd log decoder + completeness check
```

## Credits

Neighbouring work that informed the design: [dsh-turn-hard-delete](https://github.com/shuanzhe/dsh-turn-hard-delete) (whole-turn hard delete over the same `surfaceOp` replace), [dsh-rewind](https://github.com/SiriLee/dsh-rewind) (in-window rewind plus workspace restore), and `dsh-plugin-session-delete` (session-level deletion). What this one adds: per-message granularity, automatic step expansion to keep provider pairing intact, and a transcript-hiding layer derived from the durable log.

## Licence

MIT
