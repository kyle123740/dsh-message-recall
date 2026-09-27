/**
 * Explain what one Session's transcript should be showing after its tombstones.
 *
 * Support tool for "I deleted this and rows are still there": it decodes the
 * stored log, folds the surface, and classifies every event against the range a
 * tombstone replaced — so "inside the deleted range" (the plugin should hide it)
 * is separated from "after the tombstone" (legitimately still visible).
 *
 * Usage: node scripts/explain-session.mjs <log-path> [--tail 40]
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
