/**
 * Explain what one Session's transcript should be showing after its tombstones.
 *
 * Support tool for "I deleted this and rows are still there": it decodes the
 * stored log, folds the surface, and classifies every event against the range a
 * tombstone replaced — so "inside the deleted range" (the plugin should hide it)
 * is separated from "after the tombstone" (legitimately still visible).
 *
 * With --rows it also reports which rows the CLIENT half would keep, by loading
 * the real `lib/client.js` bundle under a stub loader and calling its own
 * `shadowRanges` — the same predicate the page runs, not a re-implementation.
 *
 * Usage: node scripts/explain-session.mjs <log-path> [--tail 40] [--rows]
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { foldSurface } from "@deepseek-ai/dsh-session/surface";

const file = process.argv[2];
const tailFlag = process.argv.indexOf("--tail");
const tail = tailFlag === -1 ? 24 : Number(process.argv[tailFlag + 1]);
const ZSTD_MAGIC = 4247762216;

function decode(path) {
	const raw = readFileSync(path);
	if (!path.endsWith(".zstd")) return raw.toString("utf8");
	const parts = [];
	let offset = 0;
	while (offset + 4 <= raw.length) {
		if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) break;
		let end = raw.length;
		for (let probe = offset + 4; probe + 4 <= raw.length; probe += 1) {
			if (raw.readUInt32LE(probe) === ZSTD_MAGIC) {
				end = probe;
				break;
			}
		}
		try {
			parts.push(zlib.zstdDecompressSync(raw.subarray(offset, end)).toString("utf8"));
		} catch {
			try {
				parts.push(zlib.zstdDecompressSync(raw.subarray(offset)).toString("utf8"));
			} catch {
				/* torn tail is normal while a session is open */
			}
			break;
		}
		offset = end;
	}
	return parts.join("");
}

const text = decode(file);
const events = [];
for (const line of text.split("\n")) {
	if (line === "") continue;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		continue;
	}
	if (record.seq !== undefined) events.push(record);
}

console.log(`events=${events.length} maxSeq=${events.at(-1)?.seq}`);
const fold = foldSurface(events);
console.log(`surface nodes=${fold.nodes.length}: ${fold.nodes.join(",")}`);

const tombstones = events.filter((event) => event.surfaceOp !== undefined && event.surfaceOp !== "append" && event.data?.source?.producer === "message-recall");
console.log(`\ntombstones: ${tombstones.length}`);
for (const event of tombstones) {
	const { startSeq, endSeq } = event.surfaceOp;
	console.log(`  seq ${event.seq}  ${event.data.source.action}  range [${startSeq}..${endSeq}] inclusive, tombstone at ${event.seq}`);
	console.log(`    removed surface nodes: ${event.data.source.removed?.join(",")}`);
	console.log(`    preview: ${JSON.stringify(event.data.source.preview)}`);
}

// Which events does each tombstone's range cover, and what is left after it?
for (const event of tombstones) {
	const { startSeq, endSeq } = event.surfaceOp;
	const from = event.data.source.action === "deleteFrom" ? startSeq : startSeq;
	const to = event.data.source.action === "deleteFrom" ? event.seq : endSeq;
	console.log(`\n--- range that should be hidden: [${from}..${to}) ---`);
	const inside = events.filter((item) => item.seq >= from && item.seq < to);
	const kinds = new Map();
	for (const item of inside) kinds.set(item.type, (kinds.get(item.type) ?? 0) + 1);
	console.log(`  ${inside.length} events inside: ${[...kinds].map(([type, count]) => `${type}=${count}`).join(" ")}`);
	console.log(`  surface nodes inside: ${fold.nodes.filter((seq) => seq >= from && seq < to).join(",") || "(none — already shadowed)"}`);
	const after = events.filter((item) => item.seq >= to);
	console.log(`  ${after.length} events after the tombstone (these legitimately stay):`);
	for (const item of after.slice(0, 12)) console.log(`    ${item.seq} ${item.type}${item.data?.turn === undefined ? "" : ` turn=${item.data.turn}`}${item.data?.reason === undefined ? "" : ` reason=${JSON.stringify(item.data.reason)}`}`);
}

console.log(`\n--- last ${tail} events ---`);
for (const event of events.slice(-tail)) {
	const surface = fold.nodes.includes(event.seq) ? "ON-SURFACE" : "";
	console.log(`  ${String(event.seq).padStart(5)} ${event.type.padEnd(22)} ${surface}${event.data?.turn === undefined ? "" : ` turn=${event.data.turn}`}`);
}

if (process.argv.includes("--rows")) {
	// Load the real client bundle under a stub loader so the verdict comes from the
	// shipped predicate rather than a second implementation of it.
	const win = { __ModuleLoader__: { load: (entry) => { win.__entry = entry; } } };
	globalThis.window = win;
	const reactStub = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, Fragment: "f" };
	reactStub.default = reactStub;
	globalThis.document = undefined;
	new Function("require", readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"))((name) => reactStub);
	const api = win.__entry.factory(() => reactStub);
	const shadowed = api.shadowRanges(api.tombstonesOf({ entries: events.map((event) => ({ type: "event", event })) }));

	// Which events project a transcript row, by the kind each event type maps to.
	const ROW_KINDS = {
		"user/message": "user",
		"assistant/message": "assistant-step",
		"tool/result": "tool-call",
		"turn/end": "turn-tail-or-error",
		"model/selection": null,
		"llm/retry": "model-retry",
	};
	console.log("\n--- what the CLIENT half would keep visible ---");
	const kept = [];
	const hidden = [];
	for (const event of events) {
		const kind = ROW_KINDS[event.type];
		if (kind === undefined || kind === null) continue;
		// Rows anchor at their own seq; a turn tail anchors just above its closing seq.
		const anchor = event.type === "turn/end" ? event.seq + 0.1 : event.seq;
		(shadowed(anchor) ? hidden : kept).push(`${event.seq}:${kind}`);
	}
	console.log(`  kept (${kept.length}): ${kept.join(" ")}`);
	console.log(`  hidden (${hidden.length}): ${hidden.join(" ")}`);
}
