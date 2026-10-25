import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PLUGIN = process.argv[3] ?? "D:/文档/deepseek-harness/default-workspace/dev/dsh-message-recall/lib/main.js";
const LOG = process.argv[2] ?? "D:/文档/deepseek-harness/default-workspace/sess-cur.jsonl";
const { applyRecall } = await import(pathToFileURL(PLUGIN).href);

const lines = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const isReplace = (e) => e.surfaceOp !== undefined && e.surfaceOp !== null && typeof e.surfaceOp === "object" && e.surfaceOp.op === "replace";

function buildSession(events, upto = events.length) {
	const replaced = new Set();
	for (const e of events.slice(0, upto)) {
		if (!isReplace(e)) continue;
		for (let s = e.surfaceOp.startSeq; s <= e.surfaceOp.endSeq; s += 1) replaced.add(s);
	}
	const nodes = events.slice(0, upto)
		.filter((e) => e.surfaceOp === "append" || e.type === "system/message")
		.map((e) => e.seq)
		.filter((s) => !replaced.has(s));
	const appended = [];
	return {
		snapshotEvents: () => events.slice(0, upto),
		surface: { nodes },
		append: (type, data, opts) => {
			appended.push({ type, data, opts });
			return { seq: Math.max(...events.map((e) => e.seq)) + appended.length, data };
		},
		appended,
	};
}

function describe(session, span) {
	const bySeq = new Map(session.snapshotEvents().map((e) => [e.seq, e]));
	return span.map((i) => {
		const seq = session.surface.nodes[i];
		const e = bySeq.get(seq);
		return `${i}:${seq}:${e?.type}${e?.data?.step !== undefined ? `@${e.data.turn}:${e.data.step}` : ""}`;
	});
}

const probes = (process.argv[4] ? process.argv[4].split(",").map(Number) : [8, 20, 24, 149, 152]);
for (const seq of probes) {
	const session = buildSession(lines);
	const target = session.snapshotEvents().find((e) => e.seq === seq);
	if (target === undefined) continue;
	if (!session.surface.nodes.includes(seq)) {
		console.log(`\nseq ${seq} (${target.type}) not on surface; skipped`);
		continue;
	}
	try {
		const action = process.argv[5] ?? "delete";
		const receipt = await Promise.resolve(applyRecall(session, { action, seq }));
		const op = session.appended[0].opts.surfaceOp;
		const span = [session.surface.nodes.indexOf(op.startSeq), session.surface.nodes.indexOf(op.endSeq)];
		console.log(`\n${action} seq ${seq} (${target.type})`);
		console.log(`  span ${op.startSeq}..${op.endSeq} (idx ${span[0]}..${span[1]})`);
		console.log(`  members ${describe(session, span).join(" | ")}`);
		console.log(`  kinds ${receipt.kinds.join(",")}`);
	} catch (error) {
		console.log(`\nseq ${seq} (${target.type}) -> ERROR ${error.code}: ${error.message}`);
	}
}
