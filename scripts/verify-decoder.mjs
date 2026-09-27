/**
 * Prove the frame walker consumed the whole container: a conclusion about what
 * is or is not persisted is only as good as the decoder behind it.
 *
 * Usage: node verify-decoder.mjs <file>
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
const raw = readFileSync(file);
const ZSTD_MAGIC = 4247762216;

let offset = 0;
let frames = 0;
let bytes = 0;
let text = "";
const stops = [];
while (offset < raw.length) {
	if (raw.length - offset < 4) {
		stops.push(`tail of ${raw.length - offset} byte(s) at ${offset}`);
		break;
	}
	if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) {
		stops.push(`no magic at byte ${offset} (file size ${raw.length})`);
		break;
	}
	// Read the frame header to get the exact frame length instead of guessing at
	// the next magic, which can appear inside compressed payload bytes.
	const descriptor = raw[offset + 4];
	const singleSegment = (descriptor & 0x20) !== 0;
	const contentSizeFlag = descriptor & 0x03;
	const windowDescriptorPresent = !singleSegment;
	let headerSize = 5 + (descriptor & 0x08 ? 3 : 0); // dictionary id, absent here
	let cursor = offset + headerSize;
	if (windowDescriptorPresent) cursor += 1;
	let contentSize;
	switch (contentSizeFlag) {
		case 0: contentSize = singleSegment ? undefined : undefined; break;
		case 1: contentSize = raw.readUInt32LE(cursor) + 256; cursor += 4; break;
		case 2: contentSize = Number(raw.readBigUInt64LE(cursor)) + 256; cursor += 8; break;
		default: contentSize = undefined;
	}
	if (singleSegment) {
		contentSize = raw.readUInt32LE(offset + 5);
		cursor = offset + 9;
	}
	let end;
	if (contentSize === undefined) {
		// No declared size: fall back to scanning for the next magic.
		end = raw.length;
		for (let probe = offset + 4; probe + 4 <= raw.length; probe += 1) {
			if (raw.readUInt32LE(probe) === ZSTD_MAGIC) {
				end = probe;
				break;
			}
		}
		stops.push(`frame at ${offset} has no declared content size; used next-magic=${end}`);
	} else {
		end = cursor + contentSize;
		if (end > raw.length) {
			end = raw.length;
			stops.push(`frame at ${offset} declares ${contentSize} content byte(s) but only ${raw.length - cursor} remain (torn)`);
		}
	}
	const chunk = raw.subarray(offset, end);
	try {
		text += zlib.zstdDecompressSync(chunk).toString("utf8");
		frames += 1;
		bytes += chunk.length;
	} catch (error) {
		stops.push(`frame at ${offset}..${end} failed to decompress: ${error.message}`);
		break;
	}
	offset = end;
}

const lines = text.split("\n").filter((line) => line !== "");
console.log(`file=${raw.length} consumed=${bytes} complete=${bytes === raw.length} frames=${frames} lines=${lines.length}`);
for (const stop of stops) console.log(`  note: ${stop}`);

const parsed = [];
for (const line of lines) {
	try {
		parsed.push(JSON.parse(line));
	} catch {
		console.log(`  note: unparseable line: ${line.slice(0, 80)}`);
	}
}
const events = parsed.filter((record) => record.seq !== undefined);
console.log(`records=${parsed.length} events=${events.length} maxSeq=${events.length ? Math.max(...events.map((e) => e.seq)) : "n/a"}`);
const contiguous = events.every((event, index) => event.seq === index);
console.log(`seq contiguous from 0: ${contiguous}`);
const replaces = events.filter((event) => event.surfaceOp && typeof event.surfaceOp === "object" && event.surfaceOp.op === "replace");
console.log(`replace events=${replaces.length} ${replaces.map((event) => `${event.seq}:${event.data?.source?.plugin ?? "?"}`).join(" ")}`);
console.log("last 5:", events.slice(-5).map((event) => `${event.seq}/${event.type}`).join(" "));
