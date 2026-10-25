/**
 * dsh-message-recall — Host half.
 *
 * The durable half of per-message recall and delete. The Client posts one of
 * three requests to a Session's live Agent; this module appends one
 * append-only tombstone to that Session's log and returns the receipt.
 *
 * A tombstone is a surface-replacing `user/message` that says "the span from
 * `startSeq` to `endSeq` is replaced by this event". The durable Session
 * folds the log into its surface, so the replaced span drops out of the
 * model-visible history on the next read; the tombstone stays in the log,
 * which is what a reload re-derives the hiding from.
 *
 * Three shapes, all the same primitive:
 *
 *   recall      shadow one user message          [start, start]
 *   delete      shadow one user message          [start, start]
 *   deleteFrom  shadow the suffix               [start, last]
 *
 * Recall additionally hands the recovered text back to the Client (it feeds
 * the composer draft) and refuses anything that is not a user message, so a
 * click on a reply degrades to "not actionable" instead of silently deleting
 * the wrong row.
 *
 * No HTTP of its own: the route is a thin JSON wrapper over {@link applyRecall}
 * so the same function can be driven by a test against a detached Session.
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
const MAINTENANCE_ACTIONS = new Set(["migrate", "inspect", "repair"]);

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
	// seq may arrive as a string (JSON round-trips numbers, but a Client that
	// forwards it through a template string would not); accept any form that
	// normalizes to a safe integer.
	const seq = typeof input.seq === "string" && /^\d+$/.test(input.seq) ? Number(input.seq) : input.seq;
	if (Number.isSafeInteger(seq)) {
		const index = nodes.indexOf(seq);
		if (index === -1) throw new RecallError("TARGET_NOT_FOUND", "这条消息已不在模型可见的上下文里（可能刚被撤回或删除）");
		return index;
	}
	const messageId = typeof input.messageId === "string" ? input.messageId.trim() : "";
	if (messageId !== "") {
		for (let index = 0; index < nodes.length; index += 1) {
			const event = bySeq.get(nodes[index]);
			if (event === undefined) continue;
			if (event.type === "assistant/message" && event.data.message.id === messageId) return index;
			if (event.type === "user/message" && String(event.data.id) === messageId) return index;
		}
		throw new RecallError("TARGET_NOT_FOUND", "没有找到这条消息（可能已撤回、已删除或尚未落盘）");
	}
	// Last resort: fall back to the messageId carried on the body itself.
	if (typeof input.id === "string" && input.id.trim() !== "") {
		for (let index = 0; index < nodes.length; index += 1) {
			const event = bySeq.get(nodes[index]);
			if (event === undefined) continue;
			if (event.type === "assistant/message" && event.data.message.id === input.id) return index;
			if (event.type === "user/message" && String(event.data.id) === input.id) return index;
		}
	}
	throw new RecallError("INVALID_REQUEST", "需要 seq 或 messageId");
}

/**
 * The (turn, step) one surface event belongs to, when it carries both.
 *
 * Matches every surface event that carries both numbers — including
 * reasoning/thinking blocks that newer runtimes persist as their own surface
 * events — so they fall into the same step cell as the assistant message they
 * belong to and get shadowed together.
 */
function stepOf(event) {
	if (event === undefined) return undefined;
	const { turn, step } = event.data ?? {};
	if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return undefined;
	return `${String(turn)}:${String(step)}`;
}

/**
 * The surface span one click removes.
 *
 * A user prompt is deleted alone (recall / edit / plain delete; the
 * "delete the whole turn" behaviour is a separate forward extension in
 * applyRecall). An assistant answer owns the tool results of its step (one
 * model call plus the tool executions it requested, reasoning blocks
 * included — they live inside the assistant message's content array), and an
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

	// Walk outward from `start` over the contiguous run of surface nodes that
	// belong to the same (turn, step). Walking (instead of taking the min/max of
	// every member) is what stops a delete from widening across content the user
	// is keeping: a foreign node — a compaction checkpoint, another step, the
	// next prompt's context — ends the run instead of being swallowed by it.
	//
	// The per-turn `system/message` carries the same (turn, step) as the first
	// step of its turn, but it is never deletable, so it ends the run too;
	// without that, deleting the first answer of a turn would either take the
	// system prompt with it or trip the guard below.
	const step = stepOf(event);
	if (step === undefined) return [start, start];
	let low = start;
	let high = start;
	while (low > 0) {
		const previous = bySeq.get(nodes[low - 1]);
		if (previous === undefined) break;
		if (previous.type === "system/message") break;
		if (isReplacementSurfaceEvent(previous)) break;
		if (stepOf(previous) !== step) break;
		low -= 1;
	}
	while (high < nodes.length - 1) {
		const next = bySeq.get(nodes[high + 1]);
		if (next === undefined) break;
		if (isReplacementSurfaceEvent(next)) break;
		if (stepOf(next) !== step) break;
		high += 1;
	}
	return [low, high];
}

/** The Turn one log seq belongs to, from its nearest preceding `turn/start`. */
function turnOf(bySeq, seq) {
	for (let cursor = seq; cursor >= 0; cursor -= 1) {
		const event = bySeq.get(cursor);
		if (event?.type === "turn/start") return event.data.turn;
	}
	return null;
}

/**
 * Forward span from a user prompt: delete the whole turn it started.
 *
 * One prompt is logged as a run of consecutive user rows — the text the user
 * typed plus the runtime / memos / skill / time context DSH injects beside it —
 * followed by the turn's answer: every step's assistant row (reasoning blocks
 * included, they live inside the content array) and its tool results, plus any
 * steering row the user spliced in mid-turn.
 *
 * The turn boundary is the next `turn/start`, not "the next user row": a prompt
 * is commonly followed by several injected user rows, and treating the second
 * of them as the next prompt is what used to cut the span down to
 * `[start, start + 1]` and leave the answer behind. `turnOf` reads the boundary
 * straight from the log, so a turn with any number of context rows (and any
 * number of steering rows) is covered exactly.
 *
 * @returns inclusive `[start, end]` indices over `nodes`.
 */
function userSpanForward({ bySeq, nodes }, start) {
	const turn = turnOf(bySeq, nodes[start]);
	let end = start;
	for (let index = start + 1; index < nodes.length; index += 1) {
		const ev = bySeq.get(nodes[index]);
		if (ev === undefined) break;
		// A tombstone (this plugin's own or a compaction checkpoint) breaks
		// the chain: only swallow contiguous live content.
		if (isReplacementSurfaceEvent(ev)) break;
		// The next turn's system prompt is not part of this turn.
		if (ev.type === "system/message") break;
		if (turn !== null) {
			// A row logged under a later turn is the next prompt's context: stop.
			if (turnOf(bySeq, nodes[index]) !== turn) break;
		} else if (ev.type === "user/message" && ev.data?.source?.kind === "user") {
			// No `turn/start` in the log (a seeded or truncated Session): fall
			// back to "the next typed prompt ends this turn". Never swallow the
			// rest of the conversation on the strength of a missing marker.
			break;
		}
		end = index;
	}
	return [start, end];
}

/** The tool-call ids one surface event carries. */
function toolCallsOf(event) {
	const content = event?.data?.message?.content;
	if (!Array.isArray(content)) return new Set();
	const ids = new Set();
	for (const block of content) {
		if (block?.type === "tool-call" && typeof block.id === "string") ids.add(block.id);
	}
	return ids;
}

/** The call id one tool result answers, when the event is a tool result. */
function answeredCallOf(event) {
	if (event?.type !== "tool/result") return undefined;
	const id = event.data?.message?.toolCallId ?? event.data?.toolCallId;
	return typeof id === "string" ? id : undefined;
}

/**
 * Widen a span until it cannot separate a `tool_use` from its `tool_result`.
 *
 * Providers validate the pairing on every request: an assistant message whose
 * tool calls are not immediately followed by their results is rejected, and the
 * whole conversation stays unusable until the offending message is removed
 * ("tool_use ids were found without tool_result blocks"). A raw span is allowed
 * to start anywhere — in particular on a tool result row, which is what
 * `deleteFrom` does when the user clicks a tool row — so the span is expanded
 * until every call inside it has its answer inside it, and every answer inside
 * it has its call.
 *
 * This is a widen-only repair: it can never produce a narrower span than the
 * caller asked for, so it cannot resurrect content that was already shadowed.
 */
function alignSpan({ bySeq, nodes }, span) {
	let low = span[0];
	let high = span[1];
	for (let round = 0; round <= nodes.length; round += 1) {
		let changed = false;
		// 1. Every call asked for inside the span needs its answer inside it.
		const calls = new Set();
		for (let index = low; index <= high; index += 1) {
			for (const id of toolCallsOf(bySeq.get(nodes[index]))) calls.add(id);
		}
		if (calls.size > 0) {
			for (let index = 0; index < nodes.length; index += 1) {
				const id = answeredCallOf(bySeq.get(nodes[index]));
				if (id === undefined || !calls.has(id)) continue;
				if (index < low) { low = index; changed = true; }
				else if (index > high) { high = index; changed = true; }
			}
		}
		// 2. Every answer inside the span needs the call that asked for it, or the
		//    answer is left orphaned once the call is removed.
		for (let index = low; index <= high; index += 1) {
			const id = answeredCallOf(bySeq.get(nodes[index]));
			if (id === undefined) continue;
			for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
				if (toolCallsOf(bySeq.get(nodes[cursor])).has(id)) {
					if (cursor < low) { low = cursor; changed = true; }
					break;
				}
			}
		}
		if (!changed) break;
	}
	return [low, high];
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

	// recall = withdraw one user message: single-node span.
	// delete = one message. A user prompt drags the whole exchange it started
	// (its steering rows, the assistant answer that answered it — reasoning
	// blocks included — and the tool calls that step made) up to the next user
	// prompt or a tombstone; an assistant row deletes its own step only.
	// deleteFrom = truncate to the end.
	const span = alignSpan(view,
		request.action === "deleteFrom"
			? [index, nodes.length - 1]
			: request.action === "delete" && event.type === "user/message"
				? userSpanForward(view, index)
				: spanOf(view, index));
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
	const owned = source?.producer === PLUGIN_ID || (source?.kind === "plugin" && source?.plugin === PLUGIN_ID);
	if (owned !== true) return false;
	const content = event.data?.content;
	return Array.isArray(content) && content.length === 0;
}

/**
 * Rewrite every legacy empty tombstone in one Session to the current shape and
 * report how many rows were touched.
 *
 * The rewrite keeps the tombstone's own surfaceOp span (what it already shadowed
 * is unchanged) and only fixes the content and the `source` bookkeeping, so a
 * legacy recall that "worked but re-appeared after a restart" (the v4 encoder
 * refused the `plugin` source kind and the row was silently dropped) is
 * repaired in place.
 *
 * Pure on the Session; the route wraps it with the maintenance latch.
 */
function migrateLegacyTombstones(session) {
	const events = session.snapshotEvents();
	let migrated = 0;
	for (const event of events) {
		if (!isLegacyTombstone(event)) continue;
		const source = event.data?.source;
		const ownedSeqs = Array.isArray(source?.[REMOVED_KEY]) ? source[REMOVED_KEY] : [];
		const kinds = [];
		let text = "";
		// The removed events are log-only at this point (already shadowed);
		// their text is recovered from the log where possible for the preview.
		for (const seq of ownedSeqs) {
			const removed = events.find((e) => e.seq === seq);
			if (removed === undefined) continue;
			kinds.push(labelOf(removed));
			if (text === "" && removed.type === "user/message") text = textOf(removed.data?.content);
		}
		const truncated = text.length > TEXT_PREVIEW_MAX;
		const turn = turnOf(new Map(events.map((e) => [e.seq, e])), event.seq);
		session.append("user/message", createUserMessage({
			content: [{ type: "text", text: PLACEHOLDER_TEXT }],
			source: {
				kind: "user",
				producer: PLUGIN_ID,
				action: source?.action === "deleteFrom" ? "deleteFrom" : "recall",
				[REMOVED_KEY]: ownedSeqs,
				kinds,
				turn,
				preview: truncated ? text.slice(0, TEXT_PREVIEW_MAX) : text,
				truncated,
			},
		}), {
			surfaceOp: event.surfaceOp,
			sourceEventSeqs: [event.seq],
		});
		migrated += 1;
	}
	return { migrated };
}

/**
 * The tombstone one removed span is shadowed by, when present: the log event
 * whose `source.producer` is this plugin and whose `surfaceOp` covers `seq`.
 * Returns undefined when nothing in the log shadows it.
 */
function shadowedByTombstone(events, seq) {
	for (const event of events) {
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.producer !== PLUGIN_ID && !(source?.kind === "plugin" && source?.plugin === PLUGIN_ID)) continue;
		const op = event.surfaceOp;
		if (op?.op !== "replace") continue;
		if (seq >= op.startSeq && seq <= op.endSeq) return event;
	}
	return undefined;
}

/**
 * True when a durable log event is already shadowed by a surface replacement
 * (this plugin's tombstone, a compaction checkpoint, or any other replace).
 * Such an event has left the model-visible surface, so a new deletion must not
 * re-include it in a shadow range — doing so would widen the range across
 * content the user is keeping.
 */
function isReplacementSurfaceEvent(event) {
	if (event === undefined) return false;
	const op = event.surfaceOp;
	return op !== undefined && typeof op === "object" && op.op === "replace";
}

/**
 * Remove every assistant message whose tool calls have no answers left on the
 * surface.
 *
 * This is the repair path for a Session that a previous build broke by cutting
 * a step in half: the answer stayed, its tool results did not, and from then on
 * every request is rejected ("tool_use ids were found without tool_result
 * blocks"), whichever model it is sent to. The orphan is a complete step as far
 * as `spanOf` is concerned, so deleting it also removes the results it still
 * owns and leaves a surface the provider accepts again.
 *
 * Pure on the Session; the route wraps it with the maintenance latch.
 */
function repairOrphans(session) {
	const removed = [];
	let previous = -1;
	for (let round = 0; round < 256; round += 1) {
		const view = readSurface(session);
		const { bySeq, nodes } = view;
		let orphan = -1;
		for (let index = 0; index < nodes.length; index += 1) {
			const event = bySeq.get(nodes[index]);
			if (event?.type !== "assistant/message") continue;
			const calls = toolCallsOf(event);
			if (calls.size === 0) continue;
			const answered = new Set();
			for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
				const next = bySeq.get(nodes[cursor]);
				if (next?.type === "assistant/message" || next?.type === "user/message") break;
				const id = answeredCallOf(next);
				if (id !== undefined) answered.add(id);
			}
			let missing = false;
			for (const id of calls) if (!answered.has(id)) missing = true;
			if (missing) { orphan = index; break; }
		}
		if (orphan === -1) break;
		// The appended tombstone must take the row off the surface. If the same
		// row is still the orphan after one repair, folding is not happening and
		// looping would only fill the log.
		if (nodes[orphan] === previous) break;
		previous = nodes[orphan];
		try {
			const receipt = applyRecall(session, { action: "delete", seq: nodes[orphan] });
			removed.push({ target: nodes[orphan], tombstone: receipt.seq, removed: receipt.removed });
		} catch {
			// A span this plugin refuses to widen further (e.g. the system prompt
			// guards it) ends the repair instead of looping on the same row.
			break;
		}
	}
	return { repaired: removed.length, repairs: removed };
}

/**
 * The three user-facing shapes, plus read-only and maintenance actions the
 * Client and `dsh plugin` may call.
 *
 * `recall` and `delete` shadow one node. `deleteFrom` shadows the suffix.
 * `inspect` is a read-only receipt: it answers "which rows are hidden right
 * now and why" without mutating the log. `migrate` rewrites legacy empty
 * tombstones.
 */
function normalizeRequest(input) {
	if (input === undefined || typeof input !== "object" || Array.isArray(input)) {
		throw new RecallError("INVALID_REQUEST", "请求体必须是 JSON 对象");
	}
	const sessionId = input.sessionId;
	if (typeof sessionId !== "string" || sessionId === "") {
		throw new RecallError("INVALID_REQUEST", "缺少 sessionId");
	}
	const action = input.action;
	if (typeof action !== "string" || !ACTIONS.has(action) && !MAINTENANCE_ACTIONS.has(action)) {
		throw new RecallError("INVALID_REQUEST", `未知 action "${String(action)}"`);
	}
	// Recall and delete need a target; the maintenance actions do not.
	if (!MAINTENANCE_ACTIONS.has(action)) {
		const target = input.target ?? input; // accept both shapes for the seq/messageId
		const hasTarget = Number.isSafeInteger(target.seq) || (typeof target.messageId === "string" && target.messageId !== "");
		if (!hasTarget) throw new RecallError("INVALID_REQUEST", "缺少目标（seq 或 messageId）");
	}
	return { sessionId, action, target: input.target ?? input };
}

/**
 * The durable half of one request against one live Agent: locate the target in
 * the Session, build the tombstone, append it, and return the receipt.
 *
 * The Agent's `runUnderMaintenance` latch serializes this against the Agent's
 * own turns so the replace op cannot land mid-turn; a busy Agent reports
 * `AGENT_BUSY` and the Client can retry.
 *
 * @returns the tombstone receipt.
 */
async function handle(ctx, agent, request) {
	const session = agent.session;
	if (request.action === "inspect") {
		return await inspectSession(ctx, request.sessionId);
	}
	return await runUnderMaintenance(ctx, agent, () => dispatch(session, request));
}

/**
 * The read-only receipt: what is currently hidden and why, for one Session.
 *
 * Returns the tombstones that shadow each surface node (the `removed` seqs and
 * the preview text), so the Client can answer "which rows are gone" without
 * mutating anything. Cold Sessions (no live Agent) still answer, because the
 * receipt is derived from the durable log.
 */
async function inspectSession(ctx, sessionId) {
	const session = resolveSession(ctx, sessionId);
	const events = session.snapshotEvents();
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	const nodes = [...session.surface.nodes];
	const tombstones = [];
	for (const event of events) {
		if (event.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.producer !== PLUGIN_ID && !(source?.kind === "plugin" && source?.plugin === PLUGIN_ID)) continue;
		const op = event.surfaceOp;
		if (op?.op !== "replace") continue;
		tombstones.push({
			seq: event.seq,
			surfaceOp: op,
			action: source.action,
			removed: Array.isArray(source[REMOVED_KEY]) ? source[REMOVED_KEY] : [],
			turn: source.turn,
			preview: source.preview,
			sourceKeys: Object.keys(source ?? {}),
			contentLength: Array.isArray(event.data?.content) ? event.data.content.length : 0,
			legacy: isLegacyTombstone(event),
		});
	}
	return {
		sessionId,
		live: ctx.get("agents")?.get(sessionId) !== undefined,
		eventCount: events.length,
		surfaceNodeCount: nodes.length,
		surfaceNodes: nodes.slice(0, 400),
		tombstones,
		// A handful of the most recent log events, for a "what just happened" view.
		tail: events.slice(-12).map((e) => ({ seq: e.seq, type: e.type, surfaceOp: e.surfaceOp ?? undefined })),
	};
}

/**
 * One maintenance or mutation request against one Session.
 *
 * Kept in one place so the interactive route and {@link handle} cannot drift:
 * the maintenance actions are resolved here, everything else falls through to
 * {@link applyRecall}.
 */
function dispatch(session, request) {
	if (request.action === "migrate") return migrateLegacyTombstones(session);
	if (request.action === "repair") return repairOrphans(session);
	return applyRecall(session, request);
}

/**
 * One Session by id, whether or not it is live: the receipt reads the durable
 * log, so a closed Session still answers.
 */
function resolveSession(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	if (sessions === undefined) throw new RecallError("INTERNAL", "sessions 服务未注入");
	// The 0.1.7 face is `binding(id)`; the older one is `get(id)`.
	const binding = sessions.binding?.(sessionId) ?? sessions.get?.(sessionId);
	if (binding?.session !== undefined) return binding.session;
	// A live Agent is attached even when the Sessions service exposes no
	// binding face for it (the desktop 0.1.7 build returns nothing for a
	// Session that is visibly running), so the Agent registry is consulted
	// before reporting the Session as closed.
	const live = ctx.get("agents")?.get(SessionId(sessionId))?.session;
	if (live !== undefined) return live;
	throw new RecallError("SESSION_NOT_LIVE", `会话 ${sessionId} 当前未附着，先打开它再操作`);
}

/**
 * Run one mutation under the Agent's maintenance latch, reporting `AGENT_BUSY`
 * when a turn is in flight.
 *
 * The latch is a session-wide queue: a second mutation waits for the first
 * (or for the running turn) instead of interleaving a replace op with the
 * Agent's own appends.
 */
async function runUnderMaintenance(ctx, agent, operation) {
	const sessions = ctx.get("sessions");
	const latch = sessions?.latch?.(agent.session);
	if (latch === undefined || typeof latch.run !== "function") {
		// No latch face (older DSH): run the operation directly. The replace op
		// is still atomic at the log level; only the "never mid-turn" guarantee
		// is lost.
		return operation();
	}
	try {
		return await latch.run(operation);
	} catch (error) {
		if (error?.code === "AGENT_BUSY") throw new RecallError("AGENT_BUSY", "任务正在运行，请等它结束（或先点停止）再撤回/删除。");
		throw error;
	}
}

//#region JSON wire

/** Read a bounded JSON body, keeping the envelope failures useful. */
async function readJson(request) {
	const chunks = [];
	let size = 0;
	const MAX = 64 * 1024;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX) throw new RecallError("INVALID_REQUEST", "请求体过大");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RecallError("INVALID_REQUEST", "请求体不是合法 JSON");
	}
}

/** The `SessionId` brand the Agent registry wants. */
function SessionId(value) {
	return /** @type {import("@deepseek-ai/dsh-llm").SessionId} */ (value);
}

/** A fresh message id, in the same shape the runtime uses for its own messages. */
function newMessageId() {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (typeof uuid === "string" && uuid !== "") return uuid;
	return `mcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The `UserMessage` shape the Session wants for a surface append.
 *
 * `id` and `role` are not decoration: the Session validator refuses to replay a
 * stored `user/message` whose payload is not an identified message ("session
 * event at seq N lacks an identified message"), and it does that on *load*, so a
 * tombstone without them makes the whole conversation unopenable — the delete
 * works, the Session is written, and the next restart reports it as corrupt.
 */
function createUserMessage(payload) {
	return { role: "user", id: newMessageId(), ...payload };
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
		const req = { action: input.action, ...input.target };
		const value = await runUnderMaintenance(ctx, agent, () => dispatch(agent.session, req));
		sendJson(response, 200, { ok: true, value });
	} catch (error) {
		const code = error instanceof RecallError ? error.code : "INTERNAL";
		sendJson(response, code === "INTERNAL" ? 500 : (STATUS_BY_CODE[code] ?? 400), {
			ok: false,
			error: { code, message: error instanceof Error ? error.message : String(error) },
		});
	}
}

/**
 * The shape the Client posts: the envelope names `sessionId` and `action` at
 * top level and the target beside them (or nested under `target`); the legacy
 * flat shape is still accepted, so an older Client works against a newer Host.
 */
function decodeInput(body) {
	if (body === undefined || typeof body !== "object" || Array.isArray(body)) {
		throw new RecallError("INVALID_REQUEST", "请求体必须是 JSON 对象");
	}
	const sessionId = body.sessionId ?? body.id;
	if (typeof sessionId !== "string" || sessionId === "") throw new RecallError("INVALID_REQUEST", "缺少 sessionId");
	const action = body.action;
	if (typeof action !== "string" || !(ACTIONS.has(action) || MAINTENANCE_ACTIONS.has(action))) {
		throw new RecallError("INVALID_REQUEST", `未知 action "${String(action)}"`);
	}
	// The Client posts the target flat beside the envelope; a legacy nested
	// `target` is still honored. Forward whatever is there — the seq or
	// messageId the caller supplied — so `locate` sees it.
	const target = body.target ?? body;
	return { sessionId, action, target, ...target };
}

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

export { PLUGIN_ID, PLACEHOLDER_TEXT, RECALL_PATH, RecallError, alignSpan, apply, applyRecall, dispatch, guardBlankUserMessages, handleRecallRequest, inject, isBlankContent, isLegacyTombstone, migrateLegacyTombstones, name, repairOrphans, spanOf, textOf };
