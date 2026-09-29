import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { foldSurface, isReplacementSurfaceEvent } from "@deepseek-ai/dsh-session/surface";

/**
 * dsh-message-recall — Host half.
 *
 * Per-message 撤回 / 删除 for one Session:
 *
 * - `recall`     — take back one message **you** sent. It leaves the model
 *                  context and the transcript, and records a placeholder
 *                  tombstone so the conversation shows "你撤回了一条消息".
 * - `delete`     — remove one message (a user prompt, or an assistant answer
 *                  together with the tool results it produced).
 * - `deleteFrom` — remove that message and everything after it (truncate the
 *                  Session in place; no fork, no new Session).
 *
 * The Session log is append-only, so nothing is rewritten. Each operation
 * appends one `user/message` **tombstone** carrying a short placeholder text
 * (never empty — see `applyRecall`) whose `surfaceOp` is a positional `replace`
 * over the target's surface span. The surface is the sole source of derived
 * model history, so the removed content stops reaching the model at the next
 * request; the original events stay in the log.
 *
 * Tombstones written by older versions carried `content: []`. `migrateLegacy`
 * repairs them in place (also folded into every operation) because an empty
 * user message makes strict providers reject the whole request.
 *
 * Wire: `POST /dsh-message-recall` (exact webServer route, no Typert needed).
 */

const name = "message-recall";
const inject = ["sessions", "agents", "webServer"];

/** Route the Client posts to. */
const RECALL_PATH = "/dsh-message-recall";
/** Plugin identity written into `source.plugin` of every tombstone. */
const PLUGIN_ID = "message-recall";
/** Key under the tombstone's removed Session-event seqs. */
const REMOVED_KEY = "removed";
/** Actions the Client may request. */
const ACTIONS = new Set(["recall", "delete", "deleteFrom"]);
/** Bound the recovered text stored beside a tombstone (log bytes, not content). */
const TEXT_PREVIEW_MAX = 4000;
/**
 * What every tombstone says. It must never be empty: the pi-ai adapter forwards
 * tombstones verbatim, and strict OpenAI-compatible gateways reject a user
 * message with empty content for the WHOLE request (`400 message content
 * cannot be empty`). DeepSeek's own route skips empty messages, which is why
 * the old `content: []` shape only broke on other providers.
 */
const PLACEHOLDER_TEXT = "[已撤回]";
/** Maintenance actions that mutate the log but need no target message. */
const MAINTENANCE_ACTIONS = new Set(["migrate"]);

class RecallError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RecallError";
		this.code = code;
	}
}

/** Join the prose of a content-block array, marking non-text blocks. */
function textOf(content) {
	const blocks = Array.isArray(content) ? content : [];
	const parts = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[图片]");
		else if (block.type === "file") parts.push(`[文件 ${block.attachment?.name ?? ""}]`.trim());
	}
	return parts.join("\n");
}

/** Read a Session's live log as a `seq -> event` map plus the surface order. */
function readSurface(session) {
	const events = session.snapshotEvents();
	const bySeq = new Map();
	for (const event of events) bySeq.set(event.seq, event);
	return { bySeq, nodes: [...session.surface.nodes] };
}

/** The surface index one durable message occupies; throws when it is gone. */
function locate({ bySeq, nodes }, input) {
	if (Number.isSafeInteger(input.seq)) {
		const index = nodes.indexOf(input.seq);
		if (index === -1) throw new RecallError("TARGET_NOT_FOUND", "这条消息已不在模型可见的上下文里（可能刚被撤回或删除）");
		return index;
	}
	if (typeof input.messageId === "string" && input.messageId !== "") {
		for (let index = 0; index < nodes.length; index += 1) {
			const event = bySeq.get(nodes[index]);
			if (event === undefined) continue;
			if (event.type === "assistant/message" && event.data.message.id === input.messageId) return index;
			if (event.type === "user/message" && String(event.data.id) === input.messageId) return index;
		}
		throw new RecallError("TARGET_NOT_FOUND", "没有找到这条消息（可能已撤回、已删除或尚未落盘）");
	}
	throw new RecallError("INVALID_REQUEST", "需要 seq 或 messageId");
}

/** The (turn, step) one assistant/tool surface event belongs to, when it carries both. */
function stepOf(event) {
	if (event === undefined) return undefined;
	if (event.type !== "assistant/message" && event.type !== "tool/result") return undefined;
	const { turn, step } = event.data;
	return Number.isSafeInteger(turn) && Number.isSafeInteger(step) ? `${String(turn)}:${String(step)}` : undefined;
}

/**
 * The surface span one click removes.
 *
 * A user prompt is deleted alone. An assistant answer owns the tool results of
 * its step (one model call plus the tool executions it requested), and an
 * orphan tool result would break the provider's call/result pairing, so the
 * whole step goes together — clicking either row resolves the same step.
 *
 * @returns inclusive `[start, end]` indices over `nodes`.
 */
function spanOf({ bySeq, nodes }, start) {
	const event = bySeq.get(nodes[start]);
	if (event === undefined) throw new RecallError("TARGET_NOT_FOUND", "这条消息已不在当前上下文中");
	if (isReplacementSurfaceEvent(event)) throw new RecallError("TARGET_NOT_FOUND", "这条消息已经撤回或删除过了");
	if (event.type === "system/message") throw new RecallError("NOT_DELETABLE", "系统提示不能撤回或删除");
	if (event.type === "user/message") return [start, start];

	// Group every surface node of the same step, then take its index range.
	const step = stepOf(event);
	if (step === undefined) return [start, start];
	const members = [];
	for (let index = 0; index < nodes.length; index += 1) {
		if (stepOf(bySeq.get(nodes[index])) === step) members.push(index);
	}
	const span = [members[0], members[members.length - 1]];
	// The replace op shadows the whole index range, so every node inside it must
	// belong to this step; a foreign node means the step is interleaved (a
	// compaction checkpoint landing mid-step) and cannot be removed atomically.
	for (let index = span[0]; index <= span[1]; index += 1) {
		if (index !== start && stepOf(bySeq.get(nodes[index])) !== step) {
			throw new RecallError("SPAN_NOT_CONTIGUOUS", "这一步与其它内容交错（可能已被压缩），无法单独撤回或删除");
		}
	}
	return span;
}

/** The Turn one log seq belongs to, from its nearest preceding `turn/start`. */
function turnOf(bySeq, seq) {
	for (let cursor = seq; cursor >= 0; cursor -= 1) {
		const event = bySeq.get(cursor);
		if (event?.type === "turn/start") return event.data.turn;
	}
	return null;
}

/** Machine-readable label of one surface event, localized by the Client. */
function labelOf(event) {
	if (event.type === "user/message") return "user";
	if (event.type === "assistant/message") return "assistant";
	if (event.type === "tool/result") return "tool";
	return "other";
}

/**
 * Resolve one request against one Session's live surface and append its
 * tombstone. Pure on the Session: no context lookup and no flush, so a test can
 * drive it directly against a detached Session.
 * @returns what the tombstone removed and where it landed.
 */
function applyRecall(session, request) {
	if (!ACTIONS.has(request.action)) throw new RecallError("INVALID_REQUEST", `unknown action "${String(request.action)}"`);
	const view = readSurface(session);
	const { bySeq, nodes } = view;
	const index = locate(view, request);
	const target = nodes[index];
	const event = bySeq.get(target);
	if (event.type === "system/message") throw new RecallError("NOT_DELETABLE", "系统提示不能撤回或删除");
	if (request.action === "recall" && (event.type !== "user/message" || event.data.source?.kind !== "user")) {
		throw new RecallError("NOT_A_USER_MESSAGE", "只有你自己发出的消息可以撤回；AI 回复请用删除");
	}

	const span = request.action === "deleteFrom" ? [index, nodes.length - 1] : spanOf(view, index);
	if (span[0] === 0 && bySeq.get(nodes[0])?.type === "system/message") {
		throw new RecallError("NOT_DELETABLE", "系统提示不能撤回或删除");
	}

	const startSeq = nodes[span[0]];
	const endSeq = nodes[span[1]];
	const shadowed = nodes.slice(span[0], span[1] + 1);

	const kinds = [];
	let text = "";
	for (const seq of shadowed) {
		const removed = bySeq.get(seq);
		if (removed === undefined) continue;
		kinds.push(labelOf(removed));
		if (text === "" && removed.type === "user/message") text = textOf(removed.data.content);
	}
	const truncated = text.length > TEXT_PREVIEW_MAX;
	const turn = turnOf(bySeq, startSeq);

	const tombstone = session.append("user/message", createUserMessage({
		// Non-empty by contract — see PLACEHOLDER_TEXT. Hiding is keyed on
		// `source.producer` and the replace range, never on this text, and the
		// text stays invisible in the UI because a surface-replacement node is
		// not an append-surface event.
		content: [{ type: "text", text: PLACEHOLDER_TEXT }],
		source: {
			// The durable format (v4) refuses `kind: "plugin"`: a message source
			// must name a PRODUCER kind, and the persistence encoder throws on the
			// whole batch when it does not — which is how a tombstone could live in
			// memory, render its note, and still vanish on the next restart. So the
			// tombstone declares the registered `user` kind and carries the
			// plugin's identity beside it.
			kind: "user",
			producer: PLUGIN_ID,
			action: request.action,
			[REMOVED_KEY]: shadowed,
			kinds,
			turn,
			preview: truncated ? text.slice(0, TEXT_PREVIEW_MAX) : text,
			truncated,
		},
	}), {
		surfaceOp: { op: "replace", startSeq, endSeq },
		sourceEventSeqs: shadowed,
	});

	return {
		action: request.action,
		seq: tombstone.seq,
		turn,
		removed: shadowed,
		kinds,
		preview: tombstone.data.source.preview,
		truncated,
		targetSeq: target,
	};
}

/**
 * Is this log event one of our own tombstones, written in the old empty shape?
 *
 * Matches both historic identities (`producer` since v0.1.3, `plugin` before
 * that) and requires a literally empty content array, so a current tombstone is
 * never a candidate.
 */
function isLegacyTombstone(event) {
	if (event?.type !== "user/message") return false;
	const op = event.surfaceOp;
	if (op === null || typeof op !== "object" || op.op !== "replace") return false;
	const source = event.data?.source;
	if (source?.producer !== PLUGIN_ID && source?.plugin !== PLUGIN_ID) return false;
	return Array.isArray(event.data?.content) && event.data.content.length === 0;
}

/**
 * Replace every legacy (empty) tombstone still on the surface.
 *
 * An empty tombstone is a user message with no content, and the pi-ai adapter
 * forwards it verbatim — so on any provider that validates message content the
 * ENTIRE request fails with `400 message content cannot be empty`, which reads
 * to the user as "this model is broken" rather than "I deleted a message two
 * weeks ago". The log is append-only, so the repair appends a fresh tombstone
 * whose replace span is the legacy node itself: the empty node leaves the
 * surface, the new one carries the same placeholder a current tombstone does,
 * and it keeps the legacy `removed` list so the Client's hiding derivation is
 * bit-for-bit unchanged.
 *
 * Idempotent: once repaired, no legacy node remains on the surface, so the next
 * pass appends nothing.
 *
 * @returns how many legacy tombstones were replaced.
 */
function migrateLegacyTombstones(session) {
	const events = session.snapshotEvents();
	const bySeq = new Map();
	for (const event of events) bySeq.set(event.seq, event);
	const surface = new Set(session.surface.nodes);
	const legacy = events.filter((event) => surface.has(event.seq) && isLegacyTombstone(event));
	for (const event of legacy) {
		const source = event.data.source ?? {};
		session.append("user/message", createUserMessage({
			content: [{ type: "text", text: PLACEHOLDER_TEXT }],
			source: {
				kind: "user",
				producer: PLUGIN_ID,
				action: typeof source.action === "string" ? source.action : "delete",
				[REMOVED_KEY]: Array.isArray(source.removed) && source.removed.length > 0 ? source.removed : [event.seq],
				kinds: Array.isArray(source.kinds) ? source.kinds : [],
				turn: source.turn ?? turnOf(bySeq, event.seq),
				preview: typeof source.preview === "string" ? source.preview : "",
				truncated: source.truncated === true,
				migratedFrom: event.seq,
			},
		}), {
			surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq },
			sourceEventSeqs: [event.seq],
		});
	}
	return legacy.length;
}

/**
 * Read-only diagnostic: what a Session's log actually contains, live or on disk.
 *
 * This exists because "the deletion worked, then came back after a restart" has
 * two completely different causes (the tombstone never reached storage vs the
 * client not honouring it), and only the log can tell them apart. Cold Sessions
 * are read through `sessionQuery`, i.e. through the same persisted bytes a
 * restart would load.
 */
async function inspectSession(ctx, sessionId) {
	const id = SessionId(sessionId);
	const live = ctx.get("sessions")?.get(id);
	let events;
	let surfaceNodes;
	if (live !== void 0) {
		events = live.snapshotEvents();
		surfaceNodes = [...live.surface.nodes];
	} else {
		const query = ctx.get("sessionQuery");
		if (query === void 0) throw new RecallError("SESSION_NOT_LIVE", `session "${sessionId}" is not live and no sessionQuery is available`);
		const loaded = await query.readSession(id);
		events = loaded.events;
		surfaceNodes = foldSurface(events).nodes;
	}
	const tombstones = [];
	for (const event of events) {
		if (event.type !== "user/message") continue;
		const op = event.surfaceOp;
		if (op === null || typeof op !== "object" || op.op !== "replace") continue;
		const source = event.data?.source ?? {};
		tombstones.push({
			seq: event.seq,
			surfaceOp: op,
			plugin: source.plugin,
			action: source.action,
			removed: Array.isArray(source.removed) ? source.removed : undefined,
			turn: source.turn,
			preview: typeof source.preview === "string" ? source.preview.slice(0, 40) : undefined,
			sourceKeys: Object.keys(source),
			contentLength: event.data?.content?.length,
			// `legacy: true` means this tombstone still carries the old empty
			// content, i.e. it will 400 a strict provider until it is repaired.
			legacy: isLegacyTombstone(event),
		});
	}
	return {
		sessionId,
		live: live !== void 0,
		eventCount: events.length,
		surfaceNodeCount: surfaceNodes.length,
		surfaceNodes,
		tombstones,
		tail: events.slice(-8).map((event) => ({ seq: event.seq, type: event.type, surfaceOp: event.surfaceOp })),
	};
}

/** Resolve one request against a live Session, perform it, and flush. */
async function handle(ctx, agent, request) {
	const session = agent.session;
	if (ctx.get("sessions").get(session.id) !== session) throw new RecallError("SESSION_NOT_LIVE", `session "${session.id}" is no longer live`);
	// Legacy empty tombstones ride along with every operation: an old Session
	// starts answering strict providers again the first time it is touched,
	// without the user having to ask for a repair.
	const migrated = migrateLegacyTombstones(session);
	if (request.action === "migrate") {
		if (migrated > 0) await ctx.get("sessions").flush(session);
		return { action: "migrate", migrated };
	}
	const value = applyRecall(session, request);
	if (migrated > 0) value.migrated = migrated;
	await ctx.get("sessions").flush(session);
	return value;
}

/** Run the operation under the Agent's maintenance lock (never mid-step). */
async function runUnderMaintenance(ctx, agent, request) {
	try {
		return await agent.runMaintenance((signal) => {
			signal.throwIfAborted();
			return handle(ctx, agent, request);
		});
	} catch (error) {
		if (error instanceof RecallError) throw error;
		throw new RecallError("AGENT_BUSY", error instanceof Error ? error.message : String(error));
	}
}

//#region HTTP

const MAX_BODY_BYTES = 64 * 1024;

function readJson(request) {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		let settled = false;
		request.on("data", (chunk) => {
			if (settled) return;
			bytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).length : chunk.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				settled = true;
				reject(new RecallError("INVALID_REQUEST", "请求体过大"));
				return;
			}
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		});
		request.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		request.on("end", () => {
			if (settled) return;
			settled = true;
			try {
				text += decoder.decode();
				resolve(JSON.parse(text));
			} catch {
				reject(new RecallError("INVALID_REQUEST", "请求体不是合法 JSON"));
			}
		});
	});
}

function decodeInput(value) {
	if (typeof value !== "object" || value === null) throw new RecallError("INVALID_REQUEST", "请求体必须是对象");
	const input = value;
	if (typeof input.sessionId !== "string" || input.sessionId === "") throw new RecallError("INVALID_REQUEST", "sessionId 不能为空");
	if (typeof input.action !== "string") throw new RecallError("INVALID_REQUEST", "action 不能为空");
	const target = {};
	if (input.seq !== undefined) target.seq = input.seq;
	if (typeof input.messageId === "string" && input.messageId !== "") target.messageId = input.messageId;
	// `inspect` is read-only and `migrate` is a whole-log repair: neither needs a
	// target message.
	if (input.action !== "inspect" && !MAINTENANCE_ACTIONS.has(input.action) && input.seq === undefined && target.messageId === undefined) {
		throw new RecallError("INVALID_REQUEST", "需要 seq 或 messageId");
	}
	return { action: input.action, sessionId: input.sessionId, target };
}

function sendJson(response, status, value) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

const STATUS_BY_CODE = {
	AGENT_BUSY: 423,
	SESSION_NOT_LIVE: 409,
	TARGET_NOT_FOUND: 409,
	NOT_DELETABLE: 409,
	NOT_A_USER_MESSAGE: 409,
	SPAN_NOT_CONTIGUOUS: 409,
	INVALID_REQUEST: 400,
};

async function handleRecallRequest(ctx, request, response) {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	const contentType = request.headers?.["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
		sendJson(response, 415, { ok: false, error: { code: "INVALID_REQUEST", message: "需要 application/json" } });
		return;
	}
	try {
		const input = decodeInput(await readJson(request));
		// The read-only diagnostic answers for cold Sessions too, so it must not
		// hide behind the live-Agent requirement that every mutation needs.
		if (input.action === "inspect") {
			sendJson(response, 200, { ok: true, value: await inspectSession(ctx, input.sessionId) });
			return;
		}
		const agent = ctx.get("agents")?.get(SessionId(input.sessionId));
		if (agent === undefined) throw new RecallError("SESSION_NOT_LIVE", "请先打开这条会话（未在运行的会话无法修改上下文）");
		const value = await runUnderMaintenance(ctx, agent, { action: input.action, ...input.target });
		sendJson(response, 200, { ok: true, value });
	} catch (error) {
		const code = error instanceof RecallError ? error.code : "INTERNAL";
		sendJson(response, code === "INTERNAL" ? 500 : (STATUS_BY_CODE[code] ?? 400), {
			ok: false,
			error: { code, message: error instanceof Error ? error.message : String(error) },
		});
	}
}

//#endregion

/**
 * True when a message content carries nothing a provider can accept as text:
 * an empty array, an empty string, or only text blocks that are themselves
 * empty. Whitespace counts as content (gateways accept it) and so does any
 * non-text block, so this never fires on a real message.
 */
function isBlankContent(content) {
	if (typeof content === "string") return content === "";
	if (content === void 0 || content === null) return true;
	if (!Array.isArray(content)) return false;
	return content.every((block) => block?.type === "text" && typeof block.text === "string" && block.text === "");
}

/**
 * Give every blank user message a placeholder, and report how many were patched.
 *
 * Only the `user` role is touched: the gateways that reject a blank user message
 * let blank assistant and tool messages through, and rewriting an assistant
 * message would break the pi-ai replay state, which validates its block count
 * against the stored response.
 */
function guardBlankUserMessages(messages) {
	let count = 0;
	const patched = [];
	for (const message of messages) {
		if (message?.role === "user" && isBlankContent(message.content)) {
			count += 1;
			patched.push({ ...message, content: [{ type: "text", text: PLACEHOLDER_TEXT }] });
			continue;
		}
		patched.push(message);
	}
	return { messages: patched, count };
}

/**
 * One route per process, whichever mount claimed it first.
 *
 * A profile can mount this plugin through two rows (the package name, which is
 * what puts the Client bundle in the boot graph, and an exact file URL used to
 * force a fresh import without an app restart). Both run `apply`; the surface
 * route must exist once. The claim is released with the registration, so a
 * disable/enable cycle inside one process re-registers cleanly.
 */
let routeClaimed = false;

function apply(ctx, config) {
	// The last-line guard: no Session can ever 400 on empty content again, even
	// one whose legacy tombstones were never migrated, and even if some other
	// producer writes a blank user message. `agent/pre-step` is a waterfall, so
	// awaiting `next()` first means we see the final message list — the same
	// seam a vision rewriter uses. It is deliberately not claimed once per
	// process: two live mounts running it twice is harmless (the second pass
	// finds nothing blank), while a module-level claim would wrongly skip a
	// disable/enable cycle whose listeners were disposed with the old scope.
	if (config?.emptyContentGuard !== false && typeof ctx.on === "function") {
		ctx.on("agent/pre-step", async ({ signal }, next) => {
			const decision = await next();
			if (decision?.kind === "reject" || signal?.aborted === true || !Array.isArray(decision?.messages)) return decision;
			const patched = guardBlankUserMessages(decision.messages);
			if (patched.count === 0) return decision;
			ctx.logger?.warn?.("[message-recall] %d 条空 user 消息已在发出前补上占位文本（该会话还有未修复的旧墓碑，可调用 action:migrate 彻底清理）", patched.count);
			return { ...decision, messages: patched.messages };
		}, { prepend: false });
	}
	const webServer = ctx.get("webServer");
	if (webServer === undefined) return;
	// The thunk is the setup; cordis runs it and keeps whatever it returns (the
	// route disposer) for teardown. Passing the disposer directly would unregister
	// the route the moment the plugin booted.
	ctx.effect(
		() => {
			if (routeClaimed) return;
			routeClaimed = true;
			const release = webServer.register({
				kind: "exact",
				path: RECALL_PATH,
				handler: (request, response) => handleRecallRequest(ctx, request, response),
			});
			return () => {
				routeClaimed = false;
				release();
			};
		},
		"message-recall: HTTP route",
	);
}

export { PLUGIN_ID, PLACEHOLDER_TEXT, RECALL_PATH, RecallError, apply, applyRecall, guardBlankUserMessages, handleRecallRequest, inject, isBlankContent, isLegacyTombstone, migrateLegacyTombstones, name, spanOf, textOf };
