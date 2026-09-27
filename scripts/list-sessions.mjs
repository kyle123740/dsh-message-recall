/**
 * Print the title and shape of every stored Session, so a screenshot can be
 * matched to the log it came from.
 *
 * Usage: node scripts/list-sessions.mjs <sessions-root> [--hours N]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const root = process.argv[2];
const hoursFlag = process.argv.indexOf("--hours");
const maxAgeMs = (hoursFlag === -1 ? 48 : Number(process.argv[hoursFlag + 1])) * 3600_000;
const ZSTD_MAGIC = 4247762216;

function decode(file) {
	const raw = readFileSync(file);
	if (!file.endsWith(".zstd")) return raw.toString("utf8");
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
			break;
		}
		offset = end;
	}
	return parts.join("");
}

const now = Date.now();
const rows = [];
for (const project of readdirSync(root)) {
	const projectDir = join(root, project);
	if (!statSync(projectDir).isDirectory()) continue;
	for (const session of readdirSync(projectDir)) {
		const dir = join(projectDir, session);
		let names;
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".jsonl.zstd") || name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			const file = join(dir, name);
			const st = statSync(file);
			if (now - st.mtimeMs > maxAgeMs) continue;
			let text = "";
			try {
				text = decode(file);
			} catch {
				continue;
			}
			let title;
			let events = 0;
			let errors = 0;
			let tombstones = 0;
			let lastUser = "";
			for (const line of text.split("\n")) {
				if (line === "") continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				events += 1;
				if (event.type === "session/title" && typeof event.data?.title === "string") title = event.data.title;
				if (event.type === "turn/end" && event.data?.reason?.kind === "error") errors += 1;
				if (event.type === "user/message" && event.surfaceOp !== "append" && event.data?.source?.producer === "message-recall") tombstones += 1;
				if (event.type === "user/message" && event.surfaceOp === "append" && event.data?.source?.kind === "user") {
					const text2 = (event.data.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join(" ").trim();
					if (text2 !== "") lastUser = text2.slice(0, 30);
				}
			}
			rows.push({ session, title: title ?? "(no title)", events, errors, tombstones, lastUser, mtime: st.mtimeMs });
		}
	}
}

rows.sort((a, b) => b.mtime - a.mtime);
for (const row of rows) {
	console.log(`${new Date(row.mtime).toISOString().slice(11, 19)}  ${row.session.slice(0, 44).padEnd(46)} events=${String(row.events).padStart(4)} errs=${String(row.errors).padStart(2)} tomb=${row.tombstones}  title=${JSON.stringify(row.title)}`);
}
