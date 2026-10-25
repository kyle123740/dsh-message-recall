import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PLUGIN = "D:/文档/deepseek-harness/default-workspace/dev/dsh-message-recall/lib/main.js";
const LOG = "D:/文档/deepseek-harness/default-workspace/sess2.jsonl";
const { repairOrphans, applyRecall } = await import(pathToFileURL(PLUGIN).href);

const all = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const isReplace = (e) => e?.surfaceOp !== null && typeof e?.surfaceOp === "object" && e.surfaceOp.op === "replace";

/** A session that pretends a legacy build cut step 1:1 in half. */
function buildSession(events, dropSeqs = []) {
	const kept = events.filter((e) => !dropSeqs.includes(e.seq));
	const replaced = new Set();
	for (const e of kept) {
		if (!isReplace(e)) continue;
		for (let s = e.surfaceOp.startSeq; s <= e.surfaceOp.endSeq; s += 1) replaced.add(s);
	}
	const nodes = kept
		.filter((e) => e.surfaceOp === "append" || e.type === "system/message")
		.map((e) => e.seq)
		.filter((s) => !replaced.has(s));
	const appended = [];
	let nextSeq = Math.max(...events.map((e) => e.seq)) + 1;
	return {
		snapshotEvents: () => kept.concat(appended.map((a) => ({ seq: a.seq, type: a.type, data: a.data, surfaceOp: a.opts.surfaceOp }))),
		surface: { get nodes() { return [...nodes]; } },
		append: (type, data, opts) => {
			const event = { seq: nextSeq++, type, data };
			appended.push({ seq: event.seq, type, data, opts });
			// Fold the replacement the way Session.surface does: the shadowed
			// range leaves the surface, the tombstone never enters it.
			const op = opts?.surfaceOp;
			if (op?.op === "replace") {
				for (let s = op.startSeq; s <= op.endSeq; s += 1) {
					const at = nodes.indexOf(s);
					if (at !== -1) nodes.splice(at, 1);
				}
			}
			return event;
		},
		appended,
	};
}

// Drop the two tool results of turn 1 / step 1 — the "answer kept, results gone"
// shape that produces the provider's tool_use error.
const broken = buildSession(all, [24, 28]);

const surfaceAfter = broken.surface.nodes;
const assistants = broken.snapshotEvents().filter((e) => e.type === "assistant/message" && surfaceAfter.includes(e.seq));
console.log("surface nodes:", surfaceAfter.length, "assistants on surface:", assistants.length);

const result = repairOrphans(broken);
console.log("repair:", JSON.stringify({ repaired: result.repaired, repairs: result.repairs.map((r) => ({ target: r.target, tombstone: r.tombstone })) }));

const after = broken.surface.nodes;
const stillBroken = [];
const bySeq = new Map(broken.snapshotEvents().map((e) => [e.seq, e]));
for (let i = 0; i < after.length; i += 1) {
	const e = bySeq.get(after[i]);
	if (e?.type !== "assistant/message") continue;
	const calls = (e.data?.message?.content ?? []).filter((b) => b?.type === "tool-call").map((b) => b.id);
	if (calls.length === 0) continue;
	const answered = new Set();
	for (let j = i + 1; j < after.length; j += 1) {
		const next = bySeq.get(after[j]);
		if (next?.type === "assistant/message" || next?.type === "user/message") break;
		const id = next?.data?.message?.toolCallId;
		if (id) answered.add(id);
	}
	const missing = calls.filter((id) => !answered.has(id));
	if (missing.length > 0) stillBroken.push({ seq: e.seq, missing });
}
console.log("remaining orphans:", JSON.stringify(stillBroken));

// And deleting an answer must never leave its results behind either.
const clean = buildSession(all);
const receipt = applyRecall(clean, { action: "delete", seq: 20 });
console.log("delete step 1:1 ->", receipt.removed.join(","));
