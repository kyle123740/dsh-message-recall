/**
 * Offline check of the Client half: a hand-built DOM plus a React stub whose
 * createElement invokes function components, so the real decoration path
 * (rows → action cluster → RPC → tombstone note) runs without a browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const failures = [];
function check(label, condition, detail) {
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

//#region tiny DOM

let uid = 0;
const camel = (name) => name.replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());

class El {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.uid = ++uid;
		this.children = [];
		this.parentElement = null;
		this.attributes = new Map();
		this.dataset = {};
		this.style = {};
		this.listeners = new Map();
		this._text = "";
		this.hidden = false;
		this.classes = new Set();
		this.classList = {
			contains: (name) => this.classes.has(name),
			add: (name) => this.classes.add(name),
			remove: (name) => this.classes.delete(name),
		};
	}
	get className() {
		return [...this.classes].join(" ");
	}
	set className(value) {
		this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
	}
	get textContent() {
		if (this.children.length > 0) return this.children.map((child) => child.textContent).join("");
		return this._text;
	}
	set textContent(value) {
		this._text = String(value);
		this.children.length = 0;
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value));
		if (name.startsWith("data-")) this.dataset[camel(name.slice(5))] = String(value);
	}
	appendChild(node) {
		node.parentElement?.remove();
		node.parentElement = this;
		this.children.push(node);
		return node;
	}
	after(node) {
		const index = this.parentElement.children.indexOf(this);
		this.parentElement.children.splice(index + 1, 0, node);
		node.parentElement = this.parentElement;
		return node;
	}
	remove() {
		if (this.parentElement === null) return;
		const index = this.parentElement.children.indexOf(this);
		if (index >= 0) this.parentElement.children.splice(index, 1);
		this.parentElement = null;
	}
	get nextElementSibling() {
		if (this.parentElement === null) return null;
		return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
	}
	addEventListener(type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}
	click() {
		for (const handler of this.listeners.get("click") ?? []) handler({ target: this, currentTarget: this });
	}
	descendants() {
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
	querySelectorAll(selector) {
		return selectAll(this, selector);
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

function matchesOne(node, token) {
	const parts = [];
	const pattern = /(\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*)/g;
	let match;
	while ((match = pattern.exec(token)) !== null) parts.push(match[0]);
	for (const part of parts) {
		if (part.startsWith(".")) {
			if (!node.classes.has(part.slice(1))) return false;
		} else if (part.startsWith("[")) {
			const body = part.slice(1, -1);
			const eq = body.indexOf("=");
			if (eq === -1) {
				if (!node.attributes.has(body) && node.dataset[camel(body.slice(5))] === undefined) return false;
			} else {
				const name = body.slice(0, eq);
				const want = body.slice(eq + 1).replaceAll('"', "");
				const have = node.attributes.has(name) ? node.attributes.get(name) : node.dataset[camel(name.slice(5))];
				if (String(have) !== want) return false;
			}
		} else if (node.tagName !== part.toUpperCase()) return false;
	}
	return true;
}

function selectAll(root, selector) {
	const out = [];
	for (const alternative of selector.split(",")) {
		let token = alternative.trim();
		let directOnly = false;
		if (token.startsWith(":scope >")) {
			directOnly = true;
			token = token.slice(8).trim();
		}
		for (const node of directOnly ? [...root.children] : root.descendants()) {
			if (matchesOne(node, token) && !out.includes(node)) out.push(node);
		}
	}
	return out;
}

const document = {
	head: new El("head"),
	body: new El("body"),
	createElement: (tag) => new El(tag),
	querySelectorAll(selector) {
		return [...this.head.descendants(), ...this.body.descendants()].filter((node) => selectAll(this.head, selector).includes(node) || selectAll(this.body, selector).includes(node));
	},
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	},
};

//#endregion

//#region stubs

const timers = [];
const windowStub = {
	setTimeout(handler, delay) {
		timers.push(handler);
		return timers.length;
	},
	clearTimeout() {},
};

const reactStub = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}), ...(children.length === 1 ? children[0] && typeof children[0] === "object" && children[0].type === undefined ? {} : {} : {}) };
		if (typeof type === "function") return type(merged);
		return { type, props: merged };
	},
	Fragment: "fragment",
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: (body) => {
		body();
	},
	useCallback: (body) => body,
	useRef: (value) => ({ current: value }),
};
reactStub.default = reactStub;

const calls = [];
globalThis.fetch = async (path, init) => {
	const body = JSON.parse(init.body);
	calls.push({ path, body });
	return { ok: true, status: 200, json: async () => ({ ok: true, value: { seq: 900 + calls.length, ...body } }) };
};

const eventWindow = { entries: [] };
const sourceStub = {
	getSnapshot: () => eventWindow,
	subscribe: () => () => {},
};
// 0.1.7 exposes the window through `binding(id)`; the older face was `get(id)`.
const sessions = {
	binding: (id) => (id === "session-x" ? { sessionId: id, eventSource: sourceStub } : undefined),
};
const legacySessions = {
	get: (id) => (id === "session-x" ? { eventSource: sourceStub } : undefined),
};

const chatNodes = new Map();
const chatSnapshot = { order: [], nodes: { get: (key) => chatNodes.get(key) } };
const useChat = (selector) => selector(chatSnapshot);
const useSession = (selector) => selector({ running: false });
const inputActions = {
	drafts: [],
	setDraft(text) {
		this.drafts.push(text);
	},
	focus() {},
};

const registered = { locale: [], slots: [] };
/** Teardown callbacks collected from ctx.effect, newest last. */
const disposers = [];
let activeLocale = "zh-CN";
const ctx = {
	locale: {
		register(ns, dicts) {
			registered.locale.push({ ns, locales: Object.keys(dicts) });
			return () => {};
		},
		getLocale: () => ({ active: activeLocale }),
		subscribe: () => () => {},
	},
	slots: {
		inject(name, factory) {
			registered.slots.push({ name, seat: factory() });
			return () => {};
		},
		register(options, component) {
			return { options, component };
		},
	},
	effect: (value) => {
		const result = typeof value === "function" ? value() : value;
		if (typeof result === "function") disposers.push(result);
		return result;
	},
	get: (name) => (name === "sessions" ? sessions : undefined),
};
ctx.sessions = sessions;

//#endregion

//#region load the Client bundle

const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

globalThis.window = windowStub;
globalThis.document = document;
globalThis.requestAnimationFrame = (handler) => {
	handler();
	return 1;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true, writable: true });
globalThis.setTimeout = windowStub.setTimeout;
globalThis.clearTimeout = windowStub.clearTimeout;

let loaded = null;
windowStub.__ModuleLoader__ = { load(entry) {
	loaded = entry;
} };
new Function("require", source)((name) => {
	if (name === "react" || name === "react/jsx-runtime") return reactStub;
	throw new Error(`unexpected require "${name}"`);
});

check("bundle registers with __ModuleLoader__", loaded !== null && loaded.id === "dsh-message-recall");
const api = loaded.factory(() => reactStub);
check("client exports apply + inject", typeof api.apply === "function" && Array.isArray(api.inject), Object.keys(api));

api.apply(ctx);
check("dictionaries registered for zh + en", registered.locale.some((entry) => entry.ns === "message-recall" && entry.locales.includes("zh") && entry.locales.includes("en")), registered.locale);
const seat = registered.slots.find((entry) => entry.name === "conversation.input.overlay");
check("headless entry registered into conversation.input.overlay", seat !== undefined, registered.slots.map((entry) => entry.name));
check("style tag installed once", document.head.children.some((node) => node.dataset.pluginCss === "message-recall"), document.head.children.length);
api.apply(ctx);
check("second apply did not duplicate the style tag", document.head.querySelectorAll(`style[data-plugin-css="message-recall"]`).length === 1);

//#endregion

//#region decoration

const flow = new El("div");
flow.setAttribute("data-chat-flow", "");
document.body.appendChild(flow);
const makeRow = (key, kind, turn) => {
	const row = new El("div");
	row.setAttribute("data-chat-flow-key", key);
	row.setAttribute("data-chat-flow-kind", kind);
	row.setAttribute("data-chat-turn", String(turn));
	flow.appendChild(row);
	return row;
};

chatNodes.set("k-user", { key: "k-user", kind: "user", anchorSeq: 2, data: { seq: 2, content: [{ type: "text", text: "把这条撤回" }] } });
chatNodes.set("k-answer", { key: "k-answer", kind: "assistant-step", anchorSeq: 3, data: { finalNode: { seq: 3, messageId: "m-3" } } });
chatNodes.set("k-tool", { key: "k-tool", kind: "tool-call", anchorSeq: 4, data: { root: { kind: "tool-result", node: { seq: 4 } } } });
chatNodes.set("k-tail", { key: "k-tail", kind: "turn-tail", anchorSeq: 5, data: { turn: 1, seq: 5 } });
chatNodes.set("k-later", { key: "k-later", kind: "user", anchorSeq: 60, data: { seq: 60, content: [{ type: "text", text: "后面的消息" }] } });
chatSnapshot.order = [...chatNodes.keys()];

const userRow = makeRow("k-user", "user", 1);
const answerRow = makeRow("k-answer", "assistant-step", 1);
const toolRow = makeRow("k-tool", "tool-call", 1);
const tailRow = makeRow("k-tail", "turn-tail", 1);
const laterRow = makeRow("k-later", "user", 3);

/** Mount through the registered entry, adding the framework's `inject` face. */
const mount = (extra = {}) => seat.seat.component({
	sessionId: "session-x",
	useChat,
	useSession,
	inputActions,
	kit: { sessions, locale: ctx.locale },
	...seat.seat.options.inject(),
	...extra,
});
mount();

const toolsOf = (row) => row.querySelector(":scope > .dsh-mcr-tools");
check("user row decorated", toolsOf(userRow) !== null);
check("assistant row decorated", toolsOf(answerRow) !== null);
check("tool row decorated", toolsOf(toolRow) !== null);
check("turn-tail row left alone (no durable message)", toolsOf(tailRow) === null);
check("user cluster = 撤回/删除/删除此处及之后", toolsOf(userRow)?.children.map((node) => node.textContent).join("|") === "撤回|删除|删除此处及之后", toolsOf(userRow)?.children.map((node) => node.textContent));
check("assistant cluster has no 撤回", toolsOf(answerRow)?.children.length === 2, toolsOf(answerRow)?.children.map((node) => node.textContent));
check("row marked position:relative", userRow.style.position === "relative");

console.log("== recall ==");
toolsOf(userRow).children[0].click();
await flush();
check("POST /dsh-message-recall recall seq 2", calls.at(-1)?.path === "/dsh-message-recall" && calls.at(-1).body.action === "recall" && calls.at(-1).body.seq === 2 && calls.at(-1).body.sessionId === "session-x", calls.at(-1));
check("recalled text went back to the composer", inputActions.drafts.at(-1) === "把这条撤回", inputActions.drafts);
check("cluster unpinned after the call", toolsOf(userRow).dataset.pinned === undefined);

console.log("== delete arms, then fires ==");
const deleteButton = toolsOf(answerRow).children[0];
deleteButton.click();
check("first click only armed (no request)", calls.at(-1).body.action === "recall", calls.at(-1));
check("button relabelled to the confirm hint", deleteButton.textContent === "再点一次确认", deleteButton.textContent);
deleteButton.click();
await flush();
check("second click deleted the answer", calls.at(-1).body.action === "delete" && calls.at(-1).body.seq === 3, calls.at(-1));
check("label restored after firing", deleteButton.textContent === "删除", deleteButton.textContent);

const onward = toolsOf(answerRow).children[1];
onward.click();
onward.click();
await flush();
check("删除此处及之后 maps to deleteFrom", calls.at(-1).body.action === "deleteFrom", calls.at(-1));

console.log("== tool row ==");
toolsOf(toolRow).children[0].click();
toolsOf(toolRow).children[0].click();
await flush();
check("tool row resolved its own seq", calls.at(-1).body.seq === 4, calls.at(-1));

console.log("== error mapping ==");
globalThis.fetch = async () => ({ ok: false, status: 423, json: async () => ({ ok: false, error: { code: "AGENT_BUSY", message: "busy" } }) });
toolsOf(userRow).children[0].click();
await flush();
check("server error code becomes localized copy", userRow.querySelector(":scope > .dsh-mcr-error")?.textContent.includes("任务正在运行"), userRow.querySelector(":scope > .dsh-mcr-error")?.textContent);
globalThis.fetch = async (path, init) => {
	const body = JSON.parse(init.body);
	calls.push({ path, body });
	return { ok: true, status: 200, json: async () => ({ ok: true, value: { seq: 900 + calls.length, ...body } }) };
};

console.log("== tombstones hide rows and leave no placeholder ==");
// The durable shape: `kind` must be a producer-owned kind (v4 refuses "plugin"),
// so the plugin's identity rides on `producer`.
const tombstone = (seq, source) => ({ type: "event", event: { seq, type: "user/message", surfaceOp: { op: "replace", startSeq: source.removed[0], endSeq: source.removed.at(-1) }, data: { content: [], source: { kind: "user", producer: "message-recall", ...source } } } });
eventWindow.entries = [
	tombstone(50, { action: "recall", removed: [2], kinds: ["user"], turn: 1, preview: "把这条撤回", truncated: false }),
	tombstone(51, { action: "delete", removed: [3, 4], kinds: ["assistant", "tool"], turn: 1, preview: "", truncated: false }),
	tombstone(52, { action: "deleteFrom", removed: [8], kinds: ["user"], turn: 2, preview: "很长很长的一段原文", truncated: true }),
];
mount();
// A deletion must read as a deletion: no inline note, no preview of the removed
// text left behind in the transcript.
check("no placeholder rows are rendered anywhere", document.body.querySelectorAll(".dsh-mcr-note").length === 0, document.body.querySelectorAll(".dsh-mcr-note").length);
check("the recalled row is hidden", userRow.hidden === true);
check("the deleted step's rows are hidden", answerRow.hidden === true && toolRow.hidden === true);
check("hidden rows carry our marker", userRow.dataset.mcrHidden === "1");
check("hidden rows lose their cluster", toolsOf(userRow) === null);
check("the deleted text is nowhere in the DOM", !document.body.descendants().some((node) => node._text?.includes("把这条撤回")), document.body.descendants().map((node) => node._text).filter(Boolean).slice(0, 8));
// Turn 1 lost every content row, so its action bar goes with them (orphan rule);
// a later, untouched turn keeps its own bar.
check("a fully deleted turn also loses its action bar", tailRow.hidden === true);
check("a turn outside every range keeps its bar", laterRow.hidden === false);

console.log("== clearing the tombstones restores the rows ==");
eventWindow.entries = [];
mount();
check("rows come back", userRow.hidden === false && answerRow.hidden === false && toolRow.hidden === false);
check("the marker is gone too", userRow.dataset.mcrHidden === undefined);
check("clusters return", toolsOf(userRow) !== null && toolsOf(answerRow) !== null);
check("still no placeholder rows", document.body.querySelectorAll(".dsh-mcr-note").length === 0);

console.log("== foreign replacements are ignored ==");
const foreignEntries = [
	{ type: "event", event: { seq: 60, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 9 }, data: { content: [], source: { kind: "plugin", plugin: "compact", removed: [1] } } } },
	{ type: "event", event: { seq: 61, type: "user/message", surfaceOp: "append", data: { content: [{ type: "text", text: "普通消息" }], source: { kind: "user" } } } },
];
check("compaction checkpoints and plain appends are not ours", api.tombstonesOf({ entries: foreignEntries }).length === 0, api.tombstonesOf({ entries: foreignEntries }));

console.log("== another Session's flow is untouched ==");
const otherFlow = new El("div");
otherFlow.setAttribute("data-chat-flow", "");
const foreignRow = new El("div");
foreignRow.setAttribute("data-chat-flow-key", "someone-else");
foreignRow.setAttribute("data-chat-flow-kind", "user");
foreignRow.setAttribute("data-chat-turn", "1");
otherFlow.appendChild(foreignRow);
document.body.appendChild(otherFlow);
mount();
check("foreign row got no cluster", foreignRow.querySelector(":scope > .dsh-mcr-tools") === null);
check("foreign flow got no notes", otherFlow.querySelectorAll(".dsh-mcr-note").length === 0);

console.log("== while the Agent runs, clusters come off ==");
const useSessionBusy = (selector) => selector({ running: true });
mount({ useSession: useSessionBusy });
check("user cluster removed while running", toolsOf(userRow) === null);
mount();
check("cluster returns when idle", toolsOf(userRow) !== null);

console.log("== seq reader prefers durable fields ==");
check("data.seq wins", api.seqOf({ data: { seq: 7 }, anchorSeq: 99 }) === 7);
check("assistant final node next", api.seqOf({ data: { finalNode: { seq: 8 } }, anchorSeq: 99 }) === 8);
check("anchorSeq fallback", api.seqOf({ data: {}, anchorSeq: 11 }) === 11);
check("fractional synthetic anchor skipped", api.seqOf({ data: {}, anchorSeq: 1.5 }) === undefined);
check("tool node resolves through anchorSeq", api.seqOf(chatNodes.get("k-tool")) === 4);

console.log("== event window reader across session faces ==");
check("0.1.7 binding(id) face resolves", api.eventSourceOf(sessions, "session-x") === sourceStub);
check("older get(id) face still resolves", api.eventSourceOf(legacySessions, "session-x") === sourceStub);
check("an unretained session yields no source", api.eventSourceOf(sessions, "session-other") === undefined);
check("no sessions service is not fatal", api.eventSourceOf(undefined, "session-x") === undefined);

console.log("== an emptied Turn's orphan action bar goes away ==");
const orphanTail = makeRow("k-tail-7", "turn-tail", 7);
eventWindow.entries = [tombstone(80, { action: "deleteFrom", removed: [70, 71], kinds: ["user", "assistant"], turn: 7, preview: "", truncated: false })];
mount();
check("orphan turn-tail row hidden", orphanTail.hidden === true);
check("no placeholder is left behind", flow.querySelectorAll(".dsh-mcr-note").length === 0);
eventWindow.entries = [];
mount();
check("action bar returns when nothing was removed", orphanTail.hidden === false);
const filledTail = tailRow;
check("a Turn that still has content keeps its action bar", filledTail.hidden === false);

console.log("== shadowed rows really leave the transcript ==");
// The transcript is assembled from append-origin events on purpose, so a surface
// replacement does NOT hide the removed rows by itself — the bug the user saw.
const flow2 = new El("div");
flow2.setAttribute("data-chat-flow", "");
document.body.appendChild(flow2);
const ANCHORS = { "s-prompt": 90, "s-retry": 91, "s-bar": 92, "s-after": 96 };
const mkShadow = (key, kind, turn) => {
	chatNodes.set(key, { key, kind, anchorSeq: ANCHORS[key], data: kind === "user" ? { seq: ANCHORS[key], content: [{ type: "text", text: key }] } : { seq: ANCHORS[key] } });
	const row = new El("div");
	row.setAttribute("data-chat-flow-key", key);
	row.setAttribute("data-chat-flow-kind", kind);
	row.setAttribute("data-chat-turn", String(turn));
	flow2.appendChild(row);
	return row;
};
const promptRow = mkShadow("s-prompt", "user", 9);
const retryRow = mkShadow("s-retry", "model-retry", 9);
const barRow = mkShadow("s-bar", "turn-tail", 9);
const afterRow = mkShadow("s-after", "user", 10);
chatSnapshot.order = [...chatNodes.keys()];

eventWindow.entries = [tombstone(94, { action: "deleteFrom", removed: [90], kinds: ["user"], turn: 9, preview: "s-prompt", truncated: false })];
mount();
check("the deleted prompt row is hidden", promptRow.hidden === true);
check("a log-only row inside the truncate goes too", retryRow.hidden === true);
check("the turn's action bar inside the truncate goes too", barRow.hidden === true);
check("content after the tombstone stays", afterRow.hidden === false);
check("hidden rows are marked as ours", promptRow.dataset.mcrHidden === "1");
check("a hidden row loses its cluster", promptRow.querySelector(":scope > .dsh-mcr-tools") === null);
check("the truncate leaves no placeholder either", flow2.querySelectorAll(".dsh-mcr-note").length === 0);
eventWindow.entries = [];
mount();
check("clearing the tombstone brings the rows back", promptRow.hidden === false && retryRow.hidden === false && promptRow.dataset.mcrHidden === undefined);

console.log("== the reload path: a history page that drops custom source fields ==");
// A history page is a re-encoded projection of the log. If it ever strips the
// plugin's custom `source` fields, hiding must still work — `surfaceOp` is a
// protocol field and carries the same range. This is the regression the user hit:
// note present, rows back, only after a restart.
const trimmedTombstone = {
	type: "event",
	event: {
		seq: 94,
		type: "user/message",
		surfaceOp: { op: "replace", startSeq: 90, endSeq: 92 },
		// Legacy shape (pre-v0.1.3): still recognised so a page that already holds
		// one of these keeps behaving until it reloads.
		data: { content: [], source: { kind: "plugin", plugin: "message-recall" } },
	},
};
// The durable shape a v0.1.3+ tombstone has on disk, with no plugin fields at all.
const durableTombstone = {
	type: "event",
	event: {
		seq: 95,
		type: "user/message",
		surfaceOp: { op: "replace", startSeq: 90, endSeq: 92 },
		data: { content: [], source: { kind: "user", producer: "message-recall" } },
	},
};
check("the durable producer shape is recognised without any custom fields", api.tombstonesOf({ entries: [durableTombstone] }).length === 1, api.tombstonesOf({ entries: [durableTombstone] }));
check("a foreign producer is ignored", api.tombstonesOf({ entries: [{ type: "event", event: { seq: 96, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 }, data: { content: [], source: { kind: "user", producer: "compact" } } } }] }).length === 0);
eventWindow.entries = [trimmedTombstone];
mount();
check("hiding survives without source.removed", promptRow.hidden === true && retryRow.hidden === true);
check("the single-removal range stops at endSeq", afterRow.hidden === false);
const parsedTrimmed = api.tombstonesOf({ entries: [trimmedTombstone] });
check("surfaceOp endpoints are read off the event", parsedTrimmed[0]?.startSeq === 90 && parsedTrimmed[0]?.endSeq === 92, parsedTrimmed);
check("an unknown action still degrades to a note", parsedTrimmed[0]?.action === "delete" && parsedTrimmed[0]?.removed.length === 0, parsedTrimmed[0]);
eventWindow.entries = [];
mount();

console.log("== a single removal hides only its own span ==");
const shadow = api.shadowRanges([
	{ seq: 200, action: "delete", removed: [10, 11], turn: 3 },
	{ seq: 300, action: "deleteFrom", removed: [20], turn: 4 },
]);
check("step span hides itself and what it interleaves", shadow(10) === true && shadow(11) === true);
check("a single removal stops at its span", shadow(12) === false && shadow(9) === false);
check("truncate covers up to the tombstone", shadow(21) === true && shadow(299) === true);
check("truncate stops at the tombstone", shadow(300) === false && shadow(301) === false);
check("untouched seqs stay", shadow(5) === false && shadow(15) === false);
check("a row with no durable seq is never hidden", shadow(undefined) === false);

console.log("== tombstones carry their removed seqs ==");
const roundTrip = api.tombstonesOf({ entries: [{ type: "event", event: { seq: 400, type: "user/message", surfaceOp: { op: "replace", startSeq: 7, endSeq: 9 }, data: { content: [], source: { kind: "plugin", plugin: "message-recall", action: "delete", removed: [7, 8, 9], kinds: ["assistant", "tool"], turn: 2, preview: "", truncated: false } } } }] });
check("removed list round-trips", roundTrip.length === 1 && roundTrip[0].removed.join(",") === "7,8,9", roundTrip);

console.log("== a locale switch relabels the clusters ==");
activeLocale = "en-US";
mount();
check("user cluster now reads English", toolsOf(userRow)?.children.map((node) => node.textContent).join("|") === "Recall|Delete|Delete onward", toolsOf(userRow)?.children.map((node) => node.textContent));
check("cluster was rebuilt, not left in Chinese", toolsOf(userRow)?.dataset.sig.endsWith(":en") === true, toolsOf(userRow)?.dataset.sig);
activeLocale = "zh-CN";
mount();
check("switching back relabels to Chinese", toolsOf(userRow)?.children[0].textContent === "撤回", toolsOf(userRow)?.children[0].textContent);

console.log("== a repeat apply must not double-register ==");
const seatsBefore = registered.slots.length;
api.apply(ctx);
check("no extra slot registration from a repeat apply", registered.slots.length === seatsBefore, { seatsBefore, after: registered.slots.length });
check("the guard lives on the global", globalThis.__DSH_MESSAGE_RECALL_APPLIED__ === true);
check("only one seat was ever registered", seatsBefore === 1, seatsBefore);

console.log("== the guard releases on dispose, so a re-apply works ==");
// Toggling the plugin in Settings unloads and re-applies the client half. A guard
// that never releases would leave the page with no buttons until a reload — which
// is exactly the regression this pins down.
for (const dispose of [...disposers].reverse()) dispose();
check("disposing cleared the guard", globalThis.__DSH_MESSAGE_RECALL_APPLIED__ === false);
// The clusters and notes are raw DOM, so unmounting must take them with it —
// otherwise a stale note outlives the plugin unload and reads as "the delete did
// nothing" while the rows it should have hidden are back.
const orphanClusters = document.body.querySelectorAll(".dsh-mcr-tools").length;
const orphanNotes = document.body.querySelectorAll(".dsh-mcr-note").length;
check("unmounting removes the clusters and notes this plugin added", orphanClusters === 0 && orphanNotes === 0, { orphanClusters, orphanNotes });
disposers.length = 0;
api.apply(ctx);
check("a re-apply registers the seat again", registered.slots.length === seatsBefore + 1, { before: seatsBefore, after: registered.slots.length });
check("the guard is set again", globalThis.__DSH_MESSAGE_RECALL_APPLIED__ === true);

console.log("== the declaration that the hiding depends on ==");
// v0.1.4 dropped "sessions" from the inject list and read it optimistically; an
// undeclared service is not reachable through the context, so the event window
// came back undefined and the hiding stopped — while the buttons kept working.
check("`sessions` is declared in inject", api.inject.includes("sessions"), api.inject);

console.log("== the client half survives a missing session face ==");
// Row decoration must not depend on the sessions lookup: a plugin with no buttons
// because one optional service was late is a plugin that looks broken.
globalThis.__DSH_MESSAGE_RECALL_APPLIED__ = false;
for (const dispose of [...disposers].reverse()) dispose();
disposers.length = 0;
api.apply({ ...ctx, sessions: undefined, get: () => undefined });
check("apply still registers without a sessions service", registered.slots.length === seatsBefore + 2, registered.slots.length);
const noSessionSeat = registered.slots.at(-1).seat;
noSessionSeat.component({ sessionId: "session-x", useChat, useSession, inputActions, kit: {}, ...noSessionSeat.options.inject() });
check("rows are still decorated without sessions", toolsOf(userRow) !== null, toolsOf(userRow) === null ? "no cluster" : undefined);
check("the debug hook reports the missing window instead of dying", globalThis.__MCR_DEBUG__?.eventSource === false, globalThis.__MCR_DEBUG__);

console.log(failures.length === 0 ? "\nALL CLIENT CHECKS PASSED" : `\nFAILURES: ${failures.length} -> ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
