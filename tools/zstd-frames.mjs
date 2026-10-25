import fs from "node:fs";
import zlib from "node:zlib";

/** Walk zstd frames by parsing each frame's header and block headers. */
function frameEnd(buf, off) {
	if (buf.readUInt32LE(off) !== 0xfd2fb528) return -1;
	let p = off + 4;
	const fhd = buf[p++];
	const fcsFlag = fhd >> 6;
	const singleSegment = (fhd >> 5) & 1;
	const checksum = (fhd >> 2) & 1;
	const dictFlag = fhd & 3;
	if (!singleSegment) p += 1; // window descriptor
	p += [0, 1, 2, 4][dictFlag];
	const fcsSize = singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag];
	p += fcsSize;
	for (;;) {
		const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
		p += 3;
		const last = h & 1;
		const type = (h >> 1) & 3;
		const size = h >>> 3;
		p += type === 1 ? 1 : size; // RLE block carries 1 byte
		if (last === 1) break;
		if (p > buf.length) return -1;
	}
	if (checksum === 1) p += 4;
	return p;
}

const file = process.argv[2];
const buf = fs.readFileSync(file);
let off = 0;
const out = [];
let frames = 0;
while (off < buf.length) {
	if (buf.readUInt32LE(off) !== 0xfd2fb528) {
		console.error("bad magic at", off, buf.subarray(off, off + 4).toString("hex"));
		break;
	}
	const end = frameEnd(buf, off);
	if (end < 0) {
		console.error("bad frame at", off);
		break;
	}
	try {
		out.push(zlib.zstdDecompressSync(buf.subarray(off, end)));
	} catch (error) {
		console.error("decompress fail frame", frames, error.message);
	}
	frames += 1;
	off = end;
}
const text = Buffer.concat(out).toString("utf8");
const lines = text.split("\n").filter(Boolean);
console.log(JSON.stringify({ frames, bytes: buf.length, lines: lines.length }));
fs.writeFileSync(process.argv[3] ?? file + ".jsonl", text);
