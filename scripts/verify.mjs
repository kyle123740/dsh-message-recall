import { Readable } from "node:stream";
import { Session, SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply, applyRecall, handleRecallRequest } from "../lib/main.js";

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

console.log("== provider encoding: the empty tombstone must not reach the model ==");
const wire = session.deriveMessages().filter((message) => message.role === "user" && message.content.length === 0);
check("tombstones project to empty user messages (adapter skips them)", wire.length === 2, wire.length);

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
