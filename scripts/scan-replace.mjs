/**
 * Scan stored session logs for surface-replacement events (tombstones,
 * compaction checkpoints) so "the deletion did not survive a restart" can be
 * answered from disk instead of from the UI.
 *
 * Usage: node scan-replace.mjs <sessionsRoot> [--hours N]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const root = process.argv[2];
const hoursFlag = process.argv.indexOf("--hours");
const maxAgeMs = (hoursFlag === -1 ? 24 : Number(process.argv[hoursFlag + 1])) * 3600_000;
const ZSTD_MAGIC = 4247762216;

function decode(file) {
	const raw = readFileSync(file);
	if (!file.endsWith(".zstd")) return raw.toString("utf8");
	const parts = [];
	let offset = 0;
	while (offset + 4 <= raw.length) {
		if (raw.readUInt32LE(offset) !== ZSTD_MAGIC) break;
		let end = raw.length;
		for (let cursor = offset + 4; cursor + 4 <= raw.length; cursor += 1) {
			if (raw.readUInt32LE(cursor) === ZSTD_MAGIC) {
				end = cursor;
				break;
			}
		}
		try {
			parts.push(zlib.zstdDecompressSync(raw.subarray(offset, end)).toString("utf8"));
		} catch {
			// A frame whose end was guessed from a false-positive magic: fall back to
			// decompressing the remainder, which is the whole rest of the container.
			try {
				parts.push(zlib.zstdDecompressSync(raw.subarray(offset)).toString("utf8"));
			} catch {
				/* unreadable tail: a torn frame is normal for a log still open */
			}
			break;
		}
		offset = end;
	}
	return parts.join("");
}

const now = Date.now();
const sessions = [];
for (const project of readdirSync(root)) {
	const projectDir = join(root, project);
	if (!statSync(projectDir).isDirectory()) continue;
	for (const session of readdirSync(projectDir)) {
		const dir = join(projectDir, session);
		let files;
		try {
			files = readdirSync(dir).filter((name) => name.endsWith(".jsonl.zstd") || name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of files) {
			const file = join(dir, name);
			const st = statSync(file);
			if (now - st.mtimeMs > maxAgeMs) continue;
			sessions.push({ project, session, file, mtime: st.mtimeMs, size: st.size });
		}
	}
}

sessions.sort((a, b) => b.mtime - a.mtime);
console.log(`scanning ${sessions.length} log(s) modified in the last ${maxAgeMs / 3600000}h`);
for (const entry of sessions) {
	let text = "";
	try {
		text = decode(entry.file);
	} catch (error) {
		console.log(`${entry.session}  DECODE FAILED ${error.message}`);
		continue;
	}
	let replaces = 0;
	let tombstones = 0;
	let lines = 0;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		lines += 1;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const op = event.surfaceOp;
		if (op && typeof op === "object" && op.op === "replace") {
			replaces += 1;
			if (event.data?.source?.plugin === "message-recall") tombstones += 1;
		}
	}
	const flag = tombstones > 0 ? "HAS-TOMBSTONES" : replaces > 0 ? `replaces=${replaces}` : "-";
	console.log(`${entry.session}  lines=${String(lines).padStart(5)}  ${flag}  ${new Date(entry.mtime).toISOString()}`);
}
