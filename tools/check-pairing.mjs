import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const isReplace = (e) => e?.surfaceOp !== null && typeof e?.surfaceOp === "object" && e.surfaceOp.op === "replace";

function surfaceOf(events) {
	const replaced = new Set();
	for (const e of events) {
		if (!isReplace(e)) continue;
		for (let s = e.surfaceOp.startSeq; s <= e.surfaceOp.endSeq; s += 1) replaced.add(s);
	}
	return events.filter((e) => (e.surfaceOp === "append" || e.type === "system/message") && !replaced.has(e.seq));
}

const dirs = fs.readdirSync(root).filter((d) => d.startsWith("session-"));
for (const dir of dirs) {
	const file = path.join(root, dir, "session.v4.jsonl.zstd");
	if (!fs.existsSync(file)) continue;
	const jsonl = fs.existsSync(file + ".decoded.jsonl") ? file + ".decoded.jsonl" : null;
	if (!jsonl) continue;
	const events = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const surface = surfaceOf(events);
	const problems = [];
	for (let i = 0; i < surface.length; i += 1) {
		const e = surface[i];
		if (e.type !== "assistant/message") continue;
		const calls = (e.data?.message?.content ?? []).filter((b) => b?.type === "tool-call").map((b) => b.id);
		if (calls.length === 0) continue;
		const answered = new Set();
		let j = i + 1;
		for (; j < surface.length; j += 1) {
			const next = surface[j];
			if (next.type === "assistant/message") break;
			if (next.type === "user/message") break;
			if (next.type === "tool/result") answered.add(next.data?.message?.toolCallId ?? next.data?.toolCallId);
		}
		const missing = calls.filter((id) => !answered.has(id));
		if (missing.length > 0) {
			problems.push({ seq: e.seq, turn: e.data?.turn, step: e.data?.step, missing, nextType: surface[i + 1]?.type, nextSeq: surface[i + 1]?.seq });
		}
	}
	const tombs = events.filter((e) => e.data?.source?.producer === "message-recall").length;
	if (problems.length > 0) {
		console.log(`\n${dir}  events=${events.length} tombstones=${tombs} surface=${surface.length} PROBLEMS=${problems.length}`);
		for (const p of problems.slice(0, 8)) console.log(`  assistant seq ${p.seq} (t${p.turn}s${p.step}) needs [${p.missing.join(",")}], next surface = ${p.nextType}@${p.nextSeq}`);
	}
}
