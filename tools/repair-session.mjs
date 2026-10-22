import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

/**
 * Repair message-recall tombstones that were written without the `id`/`role`
 * fields the Session validator requires ("session event at seq N lacks an
 * identified message").
 *
 * The v4 artifact is a concatenated Zstandard container: frame 0 is exactly the
 * header line, every later frame is one batch of newline-terminated JSON lines.
 * The repair decodes each frame independently, patches only the offending
 * events, and re-emits one checksummed frame per input frame, so the container
 * shape (and therefore the reader's assumptions) stays intact.
 *
 * Usage: node repair-session.mjs <session.v4.jsonl.zstd> [--apply]
 */

const ZSTD_MAGIC = 4247762216;

function frameEnd(buf, off) {
	if (buf.readUInt32LE(off) !== ZSTD_MAGIC) return -1;
	let p = off + 4;
	const descriptor = buf.readUInt8(p);
	p += 1;
	if ((descriptor & 24) !== 0) return -1;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
	p += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	for (;;) {
		if (p + 3 > buf.length) return -1;
		const blockHeader = buf.readUIntLE(p, 3);
		p += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = (blockHeader >>> 1) & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return -1;
		p += blockType === 1 ? 1 : blockSize;
		if (lastBlock) break;
		if (p > buf.length) return -1;
	}
	if (checksum) p += 4;
	return p;
}

const MESSAGE_ROLE = {
	"system/message": "system",
	"developer/message": "developer",
	"user/message": "user",
	"assistant/message": "assistant",
	"tool/result": "tool",
};

/** The validator's per-event checks, reproduced so a repaired file can be proven. */
function checkMessage(event) {
	const expectedRole = MESSAGE_ROLE[event.type];
	if (expectedRole === undefined) return undefined;
	const data = event.data;
	const message = event.type === "user/message" ? data : data?.message;
	if (typeof message !== "object" || message === null) return "message missing";
	if (typeof message.id !== "string" || message.id === "") return "lacks an identified message";
	if (message.role !== expectedRole) return `role must be "${expectedRole}" (got ${String(message.role)})`;
	if (typeof message.source !== "object" || message.source === null || typeof message.source.kind !== "string" || message.source.kind === "") return "invalid source";
	if (!Array.isArray(message.content)) return "invalid content";
	if (event.type === "tool/result") {
		if (message.source.kind !== "tool" || typeof message.source.callId !== "string") return "tool source";
		if (message.toolCallId !== message.source.callId) return "mismatched tool call ids";
	}
	return undefined;
}

const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) throw new Error("usage: node repair-session.mjs <session.v4.jsonl.zstd> [--apply]");

const buf = fs.readFileSync(file);
const frames = [];
let off = 0;
while (off < buf.length) {
	const end = frameEnd(buf, off);
	if (end < 0) throw new Error(`corrupt frame at byte ${off}`);
	frames.push([off, end]);
	off = end;
}

const texts = frames.map(([start, end]) => zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
if (!texts[0].endsWith("\n") || texts[0].indexOf("\n") !== texts[0].length - 1) throw new Error("first frame is not exactly one header line");

let patched = 0;
const repaired = texts.map((text, index) => {
	if (index === 0) return text;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line === "") continue;
		const event = JSON.parse(line);
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.producer !== "message-recall" && !(source?.kind === "plugin" && source?.plugin === "message-recall")) continue;
		let changed = false;
		if (typeof event.data.id !== "string" || event.data.id === "") {
			event.data.id = crypto.randomUUID();
			changed = true;
		}
		if (event.data.role !== "user") {
			event.data.role = "user";
			changed = true;
		}
		if (changed) {
			lines[i] = JSON.stringify(event);
			patched += 1;
		}
	}
	return lines.join("\n");
});

// Prove the result against the validator before writing anything.
const problems = [];
for (const text of repaired) {
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const event = JSON.parse(line);
		const problem = checkMessage(event);
		if (problem !== undefined) problems.push({ seq: event.seq, type: event.type, problem });
	}
}
console.log(JSON.stringify({ file, frames: frames.length, patched, problems: problems.slice(0, 10), problemCount: problems.length }, null, 2));

if (problems.length > 0) {
	console.error("refusing to write: the repaired log still fails validation");
	process.exit(1);
}
if (!apply) {
	console.log("dry run; pass --apply to write");
	process.exit(0);
}

const backup = `${file}.bak-${Date.now()}`;
fs.copyFileSync(file, backup);
const out = Buffer.concat(repaired.map((text) => zlib.zstdCompressSync(Buffer.from(text, "utf8"), {
	params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
})));
fs.writeFileSync(file, out);
// Read it back the same way, to prove the written container decodes to the same lines.
const check = fs.readFileSync(file);
let cursor = 0;
let back = "";
while (cursor < check.length) {
	const end = frameEnd(check, cursor);
	if (end < 0) throw new Error("written container has a corrupt frame");
	back += zlib.zstdDecompressSync(check.subarray(cursor, end)).toString("utf8");
	cursor = end;
}
if (back !== repaired.join("")) throw new Error("written container does not decode back to the repaired text");
console.log(JSON.stringify({ backup, bytes: out.length, verified: true }));
