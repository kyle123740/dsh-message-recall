/**
 * Round-trip a tombstone through the REAL persistence backend, offline.
 *
 * The user-visible symptom was "delete works, comes back after a restart", and
 * decoding the stored logs proved the tombstones never reached disk. This test
 * writes the exact event dsh-message-recall writes through
 * @deepseek-ai/dsh-session-persistence-jsonl into a temp root, flushes, and reads
 * it back through the backend's own reader — so "does it survive a restart" is
 * answered without a running app.
 *
 * Usage: node scripts/verify-persistence.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SESSION_FORMAT_VERSION, Session, SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";

const failures = [];
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "mcr-persistence-"));
console.log(`root=${root}`);

const ctx = new Context();
const backend = new JsonlSessionPersistence(ctx, { root, compression: "zstd" });

const id = SessionId("session-mcr-persistence-test");
const meta = { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false };

// Build the exact event log the plugin produces, using the real Session.
// Order matters to the v4 lifecycle: `system/message` must sit inside an open
// turn+step, while `user/message` (the tombstone's shape) needs neither.
const session = Session.create(id, [], meta);
session.append("turn/start", { turn: 1 });
session.append("step/start", { turn: 1, step: 1 });
session.append("system/message", { turn: 1, step: 1, message: createSystemMessage("persistence probe", "mcr-test") }, { surfaceOp: "append" });
const prompt = session.append("user/message", createUserMessage({ content: [{ type: "text", text: "will be deleted" }], source: { kind: "user" } }), { surfaceOp: "append" });
session.append("assistant/message", {
	turn: 1,
	step: 1,
	message: { id: "m-answer", role: "assistant", content: [{ type: "text", text: "answer" }], source: { kind: "model", provider: "p", model: "m" } },
	stream: [],
}, { surfaceOp: "append" });
session.append("step/end", { turn: 1, step: 1 });
session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
const tombstone = session.append("user/message", createUserMessage({
	content: [],
	source: { kind: "user", producer: "message-recall", action: "delete", removed: [prompt.seq], kinds: ["user"], turn: 1, preview: "will be deleted", truncated: false },
}), { surfaceOp: { op: "replace", startSeq: prompt.seq, endSeq: prompt.seq }, sourceEventSeqs: [prompt.seq] });
console.log(`  events=${session.snapshotEvents().length} tombstoneSeq=${tombstone.seq} liveSurface=${JSON.stringify([...session.surface.nodes])}`);

// Write them through the backend exactly like the persistence plugin does.
const handle = await backend.create(meta);
await handle.append(session.snapshotEvents());
await handle.flush();
await handle.close();

// Read back through the backend's own reader (the restart path).
const reader = await backend.open(id, "read");
const stored = await reader.read();
await reader.close();

const replaces = stored.events.filter((event) => event.surfaceOp !== undefined && event.surfaceOp !== "append");
const storedSurface = foldSurface(stored.events).nodes;
console.log(`  storedEvents=${stored.events.length} storedReplaces=${replaces.length} storedSurface=${JSON.stringify(storedSurface)}`);

check("every event round-trips", stored.events.length === session.snapshotEvents().length, { stored: stored.events.length, live: session.snapshotEvents().length });
check("the tombstone is on disk", replaces.length === 1, replaces.map((event) => event.seq));
check("the tombstone keeps its replace op", replaces[0]?.surfaceOp?.op === "replace" && replaces[0]?.surfaceOp?.startSeq === prompt.seq, replaces[0]?.surfaceOp);
check("the tombstone cites its shadowed node", Array.isArray(replaces[0]?.sourceEventSeqs) && replaces[0].sourceEventSeqs.includes(prompt.seq), replaces[0]?.sourceEventSeqs);
check("the plugin source survives", replaces[0]?.data?.source?.producer === "message-recall" && replaces[0]?.data?.source?.action === "delete", replaces[0]?.data?.source);
check("the custom removed list survives", Array.isArray(replaces[0]?.data?.source?.removed) && replaces[0].data.source.removed[0] === prompt.seq, replaces[0]?.data?.source?.removed);
check("replayed surface equals the live surface", JSON.stringify(storedSurface) === JSON.stringify([...session.surface.nodes]), { storedSurface, live: [...session.surface.nodes] });
check("the deleted prompt is gone from the replayed surface", !storedSurface.includes(prompt.seq), storedSurface);

// And the strongest statement: a Session rebuilt from disk derives the same history.
const reopened = Session.create(id, stored.events, meta);
const derived = reopened.deriveMessages().map((message) => (message.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join(""));
check("a reopened Session does not derive the deleted text", !derived.some((text) => text.includes("will be deleted")), derived);
check("a reopened Session still derives the answer", derived.some((text) => text.includes("answer")), derived);

// The root cause, pinned: the durable format refuses `kind: "plugin"`, and a
// refusing encoder fails the whole batch — the event stays in memory, renders,
// and disappears on restart. This is what the v0.1.2 tombstone looked like.
const legacyId = SessionId("session-mcr-legacy-source");
const legacyMeta = { version: SESSION_FORMAT_VERSION, id: legacyId, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false };
const legacy = Session.create(legacyId, [], legacyMeta);
legacy.append("turn/start", { turn: 1 });
const legacyPrompt = legacy.append("user/message", createUserMessage({ content: [{ type: "text", text: "legacy" }], source: { kind: "user" } }), { surfaceOp: "append" });
legacy.append("user/message", createUserMessage({ content: [], source: { kind: "plugin", plugin: "message-recall", action: "delete" } }), { surfaceOp: { op: "replace", startSeq: legacyPrompt.seq, endSeq: legacyPrompt.seq }, sourceEventSeqs: [legacyPrompt.seq] });
let legacyError;
try {
	const legacyHandle = await backend.create(legacyMeta);
	await legacyHandle.append(legacy.snapshotEvents());
	await legacyHandle.flush();
	await legacyHandle.close();
} catch (error) {
	legacyError = error;
}
check("a `kind: \"plugin\"` source is refused by the durable format", legacyError !== undefined, legacyError === undefined ? "it was accepted" : undefined);
if (legacyError !== undefined) console.log(`       (${String(legacyError.message).split("\n")[0]})`);

rmSync(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PERSISTENCE CHECKS PASSED" : `\nFAILURES: ${failures.length} -> ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
