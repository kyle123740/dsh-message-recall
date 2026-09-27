/**
 * Read a DSH session log straight off disk: the backend stores a container of
 * concatenated Zstandard frames (one per appended batch), so the whole file must
 * be frame-split and each frame decompressed before the JSONL lines appear.
 *
 * Usage: node read-session-log.mjs <path-to-session.vN.jsonl[.zstd]> [--grep replace]
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
const filter = process.argv.includes("--grep") ? process.argv[process.argv.indexOf("--grep") + 1] : undefined;
const raw = readFileSync(file);

const ZSTD_MAGIC = 4247762216;
const text = (() => {
	if (file.endsWith(".zstd")) {
		const parts = [];
		let offset = 0;
		let frames = 0;
		while (offset < raw.length) {
			if (raw.length - offset < 4) break;
			if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
			// A skippable-frame-free container: find the next frame start by trying
			// successive decompressions of the remainder is unsafe, so walk the frame
			// header's content size when present, else scan for the next magic.
			let next = offset + 4;
			let found = -1;
			for (let cursor = offset + 4; cursor + 4 <= raw.length; cursor += 1) {
				if (raw.readUInt32LE(cursor) === ZSTD_MAGIC) {
					found = cursor;
					break;
				}
			}
			const end = found === -1 ? raw.length : found;
			parts.push(zlib.zstdDecompressSync(raw.subarray(offset, end)).toString("utf8"));
			frames += 1;
			next = end;
			offset = next;
		}
		console.error(`frames=${frames}`);
		return parts.join("");
	}
	return raw.toString("utf8");
})();

const lines = text.split("\n").filter((line) => line !== "");
console.error(`lines=${lines.length}`);

const events = [];
for (const [index, line] of lines.entries()) {
	try {
		events.push({ index, ...JSON.parse(line) });
	} catch {
		console.error(`unparseable line ${index}: ${line.slice(0, 120)}`);
	}
}

console.error("first record:", JSON.stringify(events[0])?.slice(0, 300));
const typeCounts = new Map();
for (const event of events) typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
console.error("types:", [...typeCounts].map(([type, count]) => `${type}=${count}`).join(" "));

const replaced = events.filter((event) => event.surfaceOp && typeof event.surfaceOp === "object" && event.surfaceOp.op === "replace");
console.error(`replace events: ${replaced.length}`);
for (const event of replaced) {
	console.log(JSON.stringify({
		seq: event.seq,
		type: event.type,
		surfaceOp: event.surfaceOp,
		sourceEventSeqs: event.sourceEventSeqs,
		contentLength: event.data?.content?.length,
		source: event.data?.source,
	}));
}

if (filter !== undefined) {
	for (const event of events) {
		const json = JSON.stringify(event);
		if (json.includes(filter)) console.error(`MATCH seq=${event.seq} type=${event.type}`);
	}
}

console.error("--- last 12 events ---");
for (const event of events.slice(-12)) {
	console.error(`${String(event.seq).padStart(5)} ${event.type} ${event.surfaceOp === undefined ? "" : JSON.stringify(event.surfaceOp)}${event.data?.turn === undefined ? "" : ` turn=${event.data.turn}`}`);
}
