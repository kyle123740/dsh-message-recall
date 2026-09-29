import { Readable } from "node:stream";
import { Session, SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply, applyRecall, guardBlankUserMessages, handleRecallRequest, isBlankContent, isLegacyTombstone, migrateLegacyTombstones, PLACEHOLDER_TEXT } from "../lib/main.js";

/** Minimal assertion helper: collect failures, print a summary, exit non-zero. */
const failures = [];
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
function expectThrow(label, action, code) {
	try {
		action();
		failures.push(label);
		console.log(`  FAIL ${label} — expected throw ${code}, got none`);
	} catch (error) {
		check(`${label} (${error.code})`, error.code === code, { message: error.message, code: error.code });
	}
}

/** The prose of a derived message list, for content-presence assertions. */
function prose(messages) {
	return messages.map((message) => (message.content ?? [])
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("|")).join(" || ");
}

/**
 * One Session with two Turns:
 *   node 0 system | T1: prompt, step1 (assistant tool-call + tool/result), step2 final
 *   answer | T2: prompt + answer.
 */
function buildSession() {
	const session = Session.create(SessionId("session-verify"));
	session.append("system/message", { turn: 0, step: 0, message: createSystemMessage("你是助手。", "verify") }, { surfaceOp: "append" });

	session.append("turn/start", { turn: 1 });
	const first = session.append("user/message", createUserMessage({
		content: [{ type: "text", text: "第一条提问" }],
		source: { kind: "user" },
	}), { surfaceOp: "append" });
	const stepCall = session.append("assistant/message", {
		turn: 1,
		step: 1,
		message: createAssistantMessage({
			content: [{ type: "tool-call", id: "call-1", name: "demo", arguments: "{}" }],
			source: { provider: "p", model: "m" },
		}),
		stream: [],
	}, { surfaceOp: "append" });
	const tool = session.append("tool/result", {
		turn: 1,
		step: 1,
		message: createToolResultMessage({ callId: "call-1", content: [{ type: "text", text: "工具结果正文" }], isError: false }),
	}, { surfaceOp: "append", sourceEventSeqs: [stepCall.seq] });
	const answer = session.append("assistant/message", {
		turn: 1,
		step: 2,
		message: createAssistantMessage({
			content: [{ type: "text", text: "第一条最终回答" }],
			source: { provider: "p", model: "m" },
		}),
		stream: [],
	}, { surfaceOp: "append" });
	session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

	session.append("turn/start", { turn: 2 });
	const second = session.append("user/message", createUserMessage({
		content: [{ type: "text", text: "第二条提问" }],
		source: { kind: "user" },
	}), { surfaceOp: "append" });
	const answer2 = session.append("assistant/message", {
		turn: 2,
		step: 1,
		message: createAssistantMessage({
			content: [{ type: "text", text: "第二条最终回答" }],
			source: { provider: "p", model: "m" },
		}),
		stream: [],
	}, { surfaceOp: "append" });
	session.append("turn/end", { turn: 2, reason: { kind: "completed" } });

	return { session, first, second, stepCall, tool, answer, answer2 };
}

console.log("== baseline ==");
const world = buildSession();
const { session, first, second, stepCall, tool, answer, answer2 } = world;
const nodes = [...session.surface.nodes];
console.log(`surface nodes: ${JSON.stringify(nodes)}  derived: ${session.deriveMessages().length}`);
check("surface holds the 7 message nodes", nodes.length === 7, nodes);
check("baseline prose carries both prompts", prose(session.deriveMessages()).includes("第一条提问"));

console.log("== recall one user message ==");
const recall = applyRecall(session, { action: "recall", seq: first.seq });
check("turn resolved from the log", recall.turn === 1, recall.turn);
check("only the prompt was shadowed", recall.removed.length === 1 && recall.removed[0] === first.seq, recall.removed);
check("kinds labelled", recall.kinds.join(",") === "user", recall.kinds);
let text = prose(session.deriveMessages());
check("recalled text left the model context", !text.includes("第一条提问"), text);
check("answers survive the recall", text.includes("第一条最终回答") && text.includes("第二条最终回答"), text);
check("preview recovered the original text", recall.preview === "第一条提问", recall.preview);

console.log("== delete an assistant step (its call + tool result together) ==");
const step = buildSession();
const stepDelete = applyRecall(step.session, { action: "delete", messageId: String(step.stepCall.data.message.id) });
check("step span covers the call and its tool result", stepDelete.removed.length === 2, stepDelete.removed);
check("step kinds", stepDelete.kinds.join(",") === "assistant,tool", stepDelete.kinds);
const stepText = prose(step.session.deriveMessages());
check("the step left the context", !stepText.includes("工具结果正文"), stepText);
check("the final answer of the turn stays", stepText.includes("第一条最终回答"), stepText);

console.log("== deleting the tool result resolves the same step ==");
const up = buildSession();
const fromTool = applyRecall(up.session, { action: "delete", seq: up.tool.seq });
check("the tool row removed its owning assistant too", fromTool.removed.length === 2, fromTool.removed);

console.log("== deleting the turn's final answer removes only that message ==");
const single = buildSession();
const only = applyRecall(single.session, { action: "delete", seq: single.answer.seq });
check("final answer removed alone", only.removed.length === 1, only.removed);

console.log("== deleteFrom truncates the tail ==");
const tail = buildSession();
const truncated = applyRecall(tail.session, { action: "deleteFrom", seq: tail.second.seq });
check("everything from the second prompt on is gone", truncated.removed.length === 2, truncated.removed);
const tailText = prose(tail.session.deriveMessages());
check("turn 2 content is gone", !tailText.includes("第二条"), tailText);
check("turn 1 content is intact", tailText.includes("第一条提问") && tailText.includes("第一条最终回答"), tailText);

console.log("== a recalled message can be recalled again (new prompt lands after it) ==");
session.append("turn/start", { turn: 3 });
const third = session.append("user/message", createUserMessage({
	content: [{ type: "text", text: "第三条提问" }],
	source: { kind: "user" },
}), { surfaceOp: "append" });
const again = applyRecall(session, { action: "recall", seq: third.seq });
check("later prompt recalled", again.removed.length === 1, again.removed);

console.log("== guards ==");
expectThrow("recall of an assistant message", () => applyRecall(session, { action: "recall", messageId: String(answer.data.message.id) }), "NOT_A_USER_MESSAGE");
expectThrow("recall of an already recalled message", () => applyRecall(session, { action: "recall", seq: first.seq }), "TARGET_NOT_FOUND");
expectThrow("recall of the system prompt", () => applyRecall(session, { action: "recall", seq: nodes[0] }), "NOT_DELETABLE");
expectThrow("unknown seq", () => applyRecall(session, { action: "delete", seq: 9999 }), "TARGET_NOT_FOUND");
expectThrow("unknown messageId", () => applyRecall(session, { action: "delete", messageId: "msg-none" }), "TARGET_NOT_FOUND");
expectThrow("deleteFrom cannot eat the system prompt", () => applyRecall(session, { action: "deleteFrom", seq: nodes[0] }), "NOT_DELETABLE");
expectThrow("missing target", () => applyRecall(session, { action: "delete" }), "INVALID_REQUEST");
expectThrow("unknown action", () => applyRecall(session, { action: "nuke", seq: 1 }), "INVALID_REQUEST");

console.log("== reload safety: replaying the log matches the live surface ==");
for (const candidate of [session, step.session, up.session, single.session, tail.session]) {
	const events = candidate.snapshotEvents();
	let folded;
	try {
		folded = foldSurface(events);
	} catch (error) {
		failures.push("foldSurface threw");
		console.log(`  FAIL foldSurface threw — ${error.message}`);
		continue;
	}
	check(`replay equals live surface (${candidate.id})`, JSON.stringify(folded.nodes) === JSON.stringify([...candidate.surface.nodes]), {
		folded: folded.nodes,
		live: [...candidate.surface.nodes],
	});
	try {
		const reopened = Session.create(SessionId("session-reopen"), events);
		reopened.deriveMessages();
		check(`reopen + derive (${candidate.id})`, true);
	} catch (error) {
		failures.push("reopen threw");
		console.log(`  FAIL reopen threw — ${error.message}`);
	}
}

console.log("== provider encoding: no tombstone may reach the model as empty content ==");
// A tombstone used to be `content: []`, on the assumption that the provider
// adapter skips empty user messages. The pi-ai adapter does NOT: it forwards
// every non-system/assistant/tool message verbatim (`textOnlyContext` in
// @deepseek-ai/dsh-llm-pi-ai), so the tombstone reaches the wire as
// `content: ""`. Strict OpenAI-compatible gateways then reject the whole
// request — SenseAudio answers HTTP 400 `messages: Validation error: message
// content cannot be empty` (and `message content parts cannot be empty` for
// `[]`). DeepSeek/TokenRhythm tolerate it, which is why the empty shape only
// surfaced on other routes. The tombstone must therefore carry a non-empty
// placeholder; hiding is keyed on `source.producer` + the replace range, not
// on this text.
const emptyWire = session.deriveMessages().filter((message) => message.role === "user" && message.content.length === 0);
check("no user message projects empty content", emptyWire.length === 0, emptyWire.length);
const tombstoneWire = session.deriveMessages().filter((message) => message.role === "user" && message.content.some((block) => block.type === "text" && block.text.length > 0));
check("tombstones project a non-empty placeholder", tombstoneWire.length >= 2, tombstoneWire.length);

console.log("== mount: apply() keeps the HTTP route registered ==");
// Mirrors cordis `Scope.effect(execute)`: the argument is the SETUP function and
// whatever it returns is collected as the teardown disposer. Handing cordis the
// disposer itself (the bug this check pins down) unregisters the route at boot.
const routes = new Map();
const disposers = [];
let disposed = 0;
const stubCtx = {
	get: (name) => (name === "webServer"
		? {
			register(route) {
				routes.set(route.path, route);
				return () => {
					disposed += 1;
					routes.delete(route.path);
				};
			},
		}
		: undefined),
	effect: (execute) => {
		if (typeof execute !== "function") throw new TypeError("Invalid effect");
		const result = execute();
		if (typeof result === "function") disposers.push(result);
	},
};
apply(stubCtx);
check("route registered on mount", routes.has("/dsh-message-recall"), [...routes.keys()]);
check("route survived the effect wiring (not disposed at boot)", disposed === 0, disposed);
for (const release of disposers) release();
check("teardown releases the route", disposed === 1 && !routes.has("/dsh-message-recall"), disposed);

console.log("== legacy repair: an empty tombstone must not survive on the surface ==");

/** The same Session plus one tombstone written in the old `content: []` shape. */
function buildLegacyWorld() {
	const world = buildSession();
	const victim = world.session.append("user/message", createUserMessage({
		content: [{ type: "text", text: "旧版删掉的提问" }],
		source: { kind: "user" },
	}), { surfaceOp: "append" });
	const legacyTomb = world.session.append("user/message", createUserMessage({
		content: [],
		source: { kind: "user", producer: "message-recall", action: "delete", removed: [victim.seq], kinds: ["user"], turn: 2, preview: "旧版删掉的提问", truncated: false },
	}), { surfaceOp: { op: "replace", startSeq: victim.seq, endSeq: victim.seq }, sourceEventSeqs: [victim.seq] });
	return { ...world, victim, legacyTomb };
}

{
	const w = buildLegacyWorld();
	check("the legacy tombstone sits on the surface", [...w.session.surface.nodes].includes(w.legacyTomb.seq), [...w.session.surface.nodes]);
	check("the legacy shape really projects an empty user message", w.session.deriveMessages().some((message) => message.role === "user" && message.content.length === 0));
	check("isLegacyTombstone flags it", isLegacyTombstone(w.session.snapshotEvents().find((event) => event.seq === w.legacyTomb.seq)));
	const count = migrateLegacyTombstones(w.session);
	check("migrate repairs exactly the legacy tombstone", count === 1, count);
	check("no empty user message survives the repair", w.session.deriveMessages().every((message) => message.content.length > 0));
	const repair = w.session.snapshotEvents().at(-1);
	check("the repair shadows the legacy node", repair.surfaceOp?.startSeq === w.legacyTomb.seq && repair.data.source.migratedFrom === w.legacyTomb.seq, repair.surfaceOp);
	check("the repair keeps the legacy removed list", JSON.stringify(repair.data.source.removed) === JSON.stringify([w.victim.seq]), repair.data.source);
	check("the deleted text stays out of the model history", !prose(w.session.deriveMessages()).includes("旧版删掉的提问"));
	check("migrate is idempotent", migrateLegacyTombstones(w.session) === 0);
	const reopened = Session.create(SessionId("session-legacy-replay"), w.session.snapshotEvents());
	check("replay lands on the same surface", JSON.stringify([...reopened.surface.nodes]) === JSON.stringify([...w.session.surface.nodes]), [...reopened.surface.nodes]);
	check("replayed history carries no empty user message", reopened.deriveMessages().every((message) => message.content.length > 0));
}

console.log("== pre-step guard: a blank user message must never leave the process ==");
check("isBlankContent: []", isBlankContent([]));
check("isBlankContent: ''", isBlankContent(""));
check("isBlankContent: [text '']", isBlankContent([{ type: "text", text: "" }]));
check("real text is not blank", !isBlankContent([{ type: "text", text: "你好" }]));
check("whitespace counts as content", !isBlankContent([{ type: "text", text: " " }]));
check("an image block counts as content", !isBlankContent([{ type: "image", attachment: {} }]));
{
	const input = [
		{ role: "system", content: [{ type: "text", text: "sys" }] },
		{ role: "user", content: [] },
		{ role: "assistant", content: [] },
		{ role: "tool", content: [] },
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	];
	const guarded = guardBlankUserMessages(input);
	check("guard patches exactly the blank user message", guarded.count === 1, guarded.count);
	check("the patched message carries the placeholder", guarded.messages[1].content[0].text === PLACEHOLDER_TEXT, guarded.messages[1]);
	check("assistant and tool messages are left alone", guarded.messages[2].content.length === 0 && guarded.messages[3].content.length === 0);
	check("untouched messages pass through by reference", guarded.messages[0] === input[0] && guarded.messages[4] === input[4]);
}
{
	const listeners = [];
	const guardCtx = {
		get: () => undefined,
		effect: () => { },
		on: (event, listener, options) => { listeners.push({ event, listener, options }); },
		logger: { warn: () => { } },
	};
	apply(guardCtx);
	check("registers the pre-step guard", listeners.some((entry) => entry.event === "agent/pre-step"), listeners.map((entry) => entry.event));
	const entry = listeners.find((x) => x.event === "agent/pre-step");
	check("runs after the default decision (waterfall)", entry.options?.prepend === false, entry.options);
	const blank = { kind: "proceed", messages: [{ role: "user", content: [] }] };
	const patched = await entry.listener({ signal: new AbortController().signal, messages: blank.messages }, async () => blank);
	check("the listener patches the blank message", patched.messages[0].content[0].text === PLACEHOLDER_TEXT, patched);
	const clean = { kind: "proceed", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
	check("a clean decision comes back identical", await entry.listener({ signal: new AbortController().signal, messages: clean.messages }, async () => clean) === clean);
	const rejected = { kind: "reject", reason: "busy" };
	check("a rejected decision is not rewritten", await entry.listener({ signal: new AbortController().signal, messages: [] }, async () => rejected) === rejected);
	const aborted = new AbortController();
	aborted.abort();
	const stale = { kind: "proceed", messages: [{ role: "user", content: [] }] };
	check("an aborted step is left alone", await entry.listener({ signal: aborted.signal, messages: stale.messages }, async () => stale) === stale);
	apply({ get: () => undefined, effect: () => { }, on: () => { throw new Error("guard must not register when disabled"); } }, { emptyContentGuard: false });
	check("config emptyContentGuard:false disables the guard", true);
}

console.log("== HTTP end to end (mock req/res against a live Session) ==");

function mockRequest(body, method = "POST", type = "application/json") {
	const stream = Readable.from(method === "GET" ? [] : [JSON.stringify(body)]);
	stream.method = method;
	stream.headers = { "content-type": type };
	return stream;
}

function mockResponse() {
	return {
		status: 0,
		headers: null,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(value) {
			this.body = value ?? "";
		},
	};
}

const live = buildSession();
const mockAgent = {
	session: live.session,
	runMaintenance: async (task) => await task(new AbortController().signal),
};
const httpCtx = {
	get: (name) => {
		if (name === "agents") return { get: () => mockAgent };
		if (name === "sessions") return { get: (id) => (id === live.session.id ? live.session : undefined), flush: async () => {} };
		return undefined;
	},
};

const okResponse = mockResponse();
await handleRecallRequest(httpCtx, mockRequest({ sessionId: "session-verify", action: "recall", seq: live.first.seq }), okResponse);
check("HTTP 200 on a successful recall", okResponse.status === 200, okResponse.status);
const okBody = JSON.parse(okResponse.body);
check("envelope carries the removed seqs", okBody.ok === true && okBody.value.removed.includes(live.first.seq), okBody);
const afterRecall = prose(live.session.deriveMessages());
check("the recalled prompt really left the derived history", !afterRecall.includes("第一条提问"), afterRecall);

const busyResponse = mockResponse();
await handleRecallRequest(httpCtx, mockRequest({ sessionId: "session-verify", action: "recall", seq: live.first.seq }), busyResponse);
check("a second recall answers 409", busyResponse.status === 409, busyResponse.status);
check("the error code round-trips for the Client", JSON.parse(busyResponse.body).error.code === "TARGET_NOT_FOUND", busyResponse.body);

// A Session holding a legacy empty tombstone must answer strict providers again,
// both on request (`migrate`) and as a side effect of any normal operation.
function legacyCtxOf(world) {
	const agent = { session: world.session, runMaintenance: async (task) => await task(new AbortController().signal) };
	return {
		get: (name) => {
			if (name === "agents") return { get: () => agent };
			if (name === "sessions") return { get: (id) => (id === world.session.id ? world.session : undefined), flush: async () => { } };
			return undefined;
		},
	};
}

const migrateWorld = buildLegacyWorld();
const migrateResponse = mockResponse();
await handleRecallRequest(legacyCtxOf(migrateWorld), mockRequest({ sessionId: "session-verify", action: "migrate" }), migrateResponse);
check("HTTP 200 on migrate, which needs no target", migrateResponse.status === 200, migrateResponse.body);
check("migrate reports what it repaired", JSON.parse(migrateResponse.body).value.migrated === 1, migrateResponse.body);
check("the migrated Session is clean for strict providers", migrateWorld.session.deriveMessages().every((message) => message.content.length > 0));
const remigrateResponse = mockResponse();
await handleRecallRequest(legacyCtxOf(migrateWorld), mockRequest({ sessionId: "session-verify", action: "migrate" }), remigrateResponse);
check("a second migrate repairs nothing", JSON.parse(remigrateResponse.body).value.migrated === 0, remigrateResponse.body);

const healWorld = buildLegacyWorld();
const healResponse = mockResponse();
await handleRecallRequest(legacyCtxOf(healWorld), mockRequest({ sessionId: "session-verify", action: "delete", seq: healWorld.second.seq }), healResponse);
check("an ordinary delete also heals legacy tombstones", JSON.parse(healResponse.body).value.migrated === 1, healResponse.body);
check("and leaves no empty user message behind", healWorld.session.deriveMessages().every((message) => message.content.length > 0));

const wrongMethod = mockResponse();
await handleRecallRequest(httpCtx, mockRequest({}, "GET"), wrongMethod);
check("GET answers 405 with Allow: POST", wrongMethod.status === 405 && wrongMethod.headers.allow === "POST", wrongMethod.headers);

const wrongType = mockResponse();
await handleRecallRequest(httpCtx, mockRequest({}, "POST", "text/plain"), wrongType);
check("a non-JSON body answers 415", wrongType.status === 415, wrongType.status);

const noAgentCtx = { get: (name) => (name === "agents" ? { get: () => undefined } : undefined) };
const coldResponse = mockResponse();
await handleRecallRequest(noAgentCtx, mockRequest({ sessionId: "session-cold", action: "delete", seq: 1 }), coldResponse);
check("a Session with no live Agent answers 409 SESSION_NOT_LIVE", coldResponse.status === 409 && JSON.parse(coldResponse.body).error.code === "SESSION_NOT_LIVE", coldResponse.body);

console.log("== the persistence listener's first operation on our event ==");
// @deepseek-ai/dsh-session-persistence-jsonl buffers with structuredClone(event)
// inside its `session/event` listener. A throw there is contained by the store
// ("observer failures are logged and contained"), which would leave the event in
// memory and never on disk — exactly the reported symptom. So clone it here.
{
	const probe = buildSession();
	const tombstone = probe.session.append("user/message", createUserMessage({
		content: [],
		source: { kind: "plugin", plugin: "message-recall", action: "delete", removed: [probe.first.seq], kinds: ["user"], turn: 1, preview: "第一条提问", truncated: false },
	}), { surfaceOp: { op: "replace", startSeq: probe.first.seq, endSeq: probe.first.seq }, sourceEventSeqs: [probe.first.seq] });
	let cloneError;
	try {
		structuredClone(tombstone);
	} catch (error) {
		cloneError = error;
	}
	check("structuredClone(tombstoneEvent) does not throw", cloneError === undefined, cloneError === undefined ? undefined : String(cloneError));

	let jsonError;
	try {
		const text = JSON.stringify(tombstone);
		const back = JSON.parse(text);
		check("the tombstone survives JSON and keeps its surfaceOp", back.surfaceOp?.op === "replace" && back.data?.source?.removed?.[0] === probe.first.seq, back.surfaceOp);
	} catch (error) {
		jsonError = error;
		check("the tombstone survives JSON", false, String(jsonError));
	}

	// Control: a plain append event from the same session, cloned the same way.
	let controlError;
	try {
		structuredClone(probe.session.snapshotEvents().find((event) => event.type === "user/message"));
	} catch (error) {
		controlError = error;
	}
	check("structuredClone(plain user/message) does not throw either", controlError === undefined, String(controlError));

	// The tombstone's own data shape, for the record.
	const source = tombstone.data.source;
	check("tombstone source keys are plain data", Object.values(source).every((value) => value === null || ["string", "number", "boolean", "object"].includes(typeof value)), Object.keys(source));
}

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\nFAILURES: ${failures.length} -> ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
