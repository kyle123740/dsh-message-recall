window.__ModuleLoader__.load({ id: "dsh-message-recall", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

const React = require("react");
const { useCallback, useEffect, useState } = React;

/**
 * dsh-message-recall — Client half.
 *
 * Gives **every message row** in a conversation a hover action cluster —
 * 撤回 (recall: only messages you sent) / 删除 (delete) / 删除此处及之后 (delete
 * onward) — and turns each tombstone the Host wrote into a small inline note,
 * so the transcript never looks silently broken.
 *
 * Chat publishes no per-row action slot for user rows, so rows are decorated
 * through the shipped flow markers (`[data-chat-flow]`, `data-chat-flow-key`,
 * `data-chat-flow-kind`). A row is decorated only when its key resolves to a
 * durable message in *this* Session's Chat store, so nothing here can aim at
 * another Session's rows, and a flow that shows a different Session is left
 * untouched.
 */

const PLUGIN_ID = "message-recall";
const ROUTE = "/dsh-message-recall";
const NS = "message-recall";
/**
 * Bundle stamp, printed once on load.
 *
 * The Host reads a plugin's client bundle into memory when the plugin mounts,
 * so editing `lib/client.js` alone does not change what the page downloads: the
 * bundle has to be re-read (disable + enable the plugin) and the page reloaded.
 * The stamp makes "which copy am I actually running" answerable from the console.
 */
const BUILD = "2026-09-27.3";

//#region styles

const CSS = `
.dsh-mcr-tools{position:absolute;top:-13px;right:8px;z-index:6;display:inline-flex;align-items:center;gap:2px;padding:2px 4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(38,38,38,.95));box-shadow:0 2px 10px rgba(0,0,0,.3);opacity:0;transition:opacity 80ms ease}
.dsh-mcr-tools[data-pinned=true]{opacity:1}
[data-chat-flow-key]:hover > .dsh-mcr-tools,[data-chat-flow-key]:focus-within > .dsh-mcr-tools{opacity:1}
.dsh-mcr-btn{border:none;background:none;color:var(--dsw-alias-label-tertiary,#9a9a9a);font:inherit;font-size:12px;line-height:1.5;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap}
.dsh-mcr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#2f2f2f);color:var(--dsw-alias-label-primary,#eee)}
.dsh-mcr-btn[data-danger=true]:hover{color:#f87171}
.dsh-mcr-btn[data-armed=true]{color:#f87171;background:var(--dsw-alias-interactive-bg-hover,#2f2f2f)}
.dsh-mcr-error{position:absolute;top:16px;right:8px;z-index:7;max-width:min(420px,80%);color:var(--dsw-alias-state-error-primary,#f87171);background:var(--dsw-alias-bg-layer-2,rgba(38,38,38,.97));border-radius:8px;padding:4px 9px;font-size:12px;line-height:1.5}
.dsh-mcr-note{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:2px 0 8px;padding:4px 10px;border-left:2px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:0 8px 8px 0;color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:12px;line-height:1.7}
.dsh-mcr-note[data-action=recall]{border-left-color:var(--dsw-alias-accent,#4f8cff)}
.dsh-mcr-note-text{flex:1 1 300px;min-width:0;overflow-wrap:anywhere}
.dsh-mcr-note-act{border:none;background:none;color:var(--dsw-alias-label-secondary,#bbb);font:inherit;font-size:12px;cursor:pointer;padding:0 2px;text-decoration:underline dotted;text-underline-offset:3px}
.dsh-mcr-note-act:hover{color:var(--dsw-alias-label-primary,#eee)}
@media (prefers-reduced-motion:reduce){.dsh-mcr-tools{transition:none}}
`;

function ensureStyle() {
	if (typeof document === "undefined" || document.querySelector(`style[data-plugin-css="${NS}"]`)) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = NS;
	tag.dataset.pluginCss = NS;
	tag.textContent = CSS;
	document.head.appendChild(tag);
}

//#endregion

//#region dictionaries

const zh = {
	"action.recall": "撤回",
	"action.delete": "删除",
	"action.deleteFrom": "删除此处及之后",
	"action.arm": "再点一次确认",
	"action.redo": "重新编辑",
	"action.copy": "复制原文",
	"action.copied": "已复制",
	"note.recall": "你撤回了一条消息",
	"note.delete": "已删除这条消息",
	"note.deleteFrom": "已删除此处及之后的全部内容",
	"note.with": "{label} · {preview}",
	"note.empty": "（该消息没有正文）",
	"note.truncated": "（内容过长，只保留开头）",
	"note.redone": "原文已放回输入框",
	"kind.user": "提问",
	"kind.assistant": "回复",
	"kind.tool": "工具调用",
	"kind.other": "内容",
	"error.AGENT_BUSY": "任务正在运行，请等它结束（或先点停止）再撤回/删除。",
	"error.TARGET_NOT_FOUND": "这条消息已经变化，或早已被撤回/删除。",
	"error.SESSION_NOT_LIVE": "这条会话当前没有运行中的 Agent，先打开它再操作。",
	"error.NOT_A_USER_MESSAGE": "只有你自己发出的消息可以撤回；AI 回复请用「删除」。",
	"error.NOT_DELETABLE": "系统提示不能撤回或删除。",
	"error.SPAN_NOT_CONTIGUOUS": "这一步与其它内容交错（可能已被压缩），无法单独撤回或删除。",
	"error.generic": "操作失败：{message}",
};
const en = {
	"action.recall": "Recall",
	"action.delete": "Delete",
	"action.deleteFrom": "Delete onward",
	"action.arm": "Click again to confirm",
	"action.redo": "Edit again",
	"action.copy": "Copy text",
	"action.copied": "Copied",
	"note.recall": "You recalled a message",
	"note.delete": "Message deleted",
	"note.deleteFrom": "Deleted this message and everything after it",
	"note.with": "{label} · {preview}",
	"note.empty": "(no text)",
	"note.truncated": "(content truncated)",
	"note.redone": "The original text is back in the composer",
	"kind.user": "prompt",
	"kind.assistant": "reply",
	"kind.tool": "tool call",
	"kind.other": "content",
	"error.AGENT_BUSY": "Wait for the task to finish before recalling or deleting.",
	"error.TARGET_NOT_FOUND": "This message changed, or was already recalled or deleted.",
	"error.SESSION_NOT_LIVE": "This Session has no live Agent; open it before recalling.",
	"error.NOT_A_USER_MESSAGE": "Only messages you sent can be recalled; use Delete for replies.",
	"error.NOT_DELETABLE": "The system prompt cannot be recalled or deleted.",
	"error.SPAN_NOT_CONTIGUOUS": "This step is interleaved (likely compacted) and cannot be removed alone.",
	"error.generic": "Operation failed: {message}",
};

/** Fill `{slot}` placeholders in a dictionary template. */
function fill(text, slots) {
	if (!slots) return text;
	let out = text;
	for (const [name, value] of Object.entries(slots)) out = out.split(`{${name}}`).join(String(value));
	return out;
}

/** The active dictionary: Chinese locales win, anything else reads English. */
function tableFor(active) {
	return typeof active === "string" && active.toLowerCase().startsWith("zh") ? zh : en;
}

//#endregion

//#region wire

async function recallRpc(body) {
	const response = await fetch(ROUTE, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	let envelope = null;
	try {
		envelope = await response.json();
	} catch {
		envelope = null;
	}
	if (envelope && envelope.ok === true) return envelope.value;
	const error = new Error(envelope?.error?.message ?? `HTTP ${String(response.status)}`);
	error.code = envelope?.error?.code;
	throw error;
}

//#endregion

//#region model readers

/**
 * The durable event window of one materialized Client Session.
 * `sessions.binding(id)` is the 0.1.7 face; `sessions.get(id)` is the older one,
 * kept so the note layer degrades to "no notes" instead of throwing.
 */
function eventSourceOf(sessions, sessionId) {
	if (sessions === undefined || sessionId === undefined) return undefined;
	const binding = sessions.binding?.(sessionId) ?? sessions.get?.(sessionId);
	return binding?.eventSource;
}

/** Plain text of a message row, with non-text blocks named. */
function rowText(content) {
	const blocks = Array.isArray(content) ? content : [];
	const parts = [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block?.type === "image") parts.push("[图片]");
		else if (block?.type === "file") parts.push(`[文件 ${block.file?.name ?? ""}]`);
	}
	return parts.join("\n");
}

/** The row kinds that stand for one durable surface message. */
const ACTIONABLE = new Set(["user", "steering", "assistant-step", "tool-call"]);

/** The durable surface seq of one Chat node, or undefined for a synthetic row. */
function seqOf(node) {
	if (node === undefined) return undefined;
	const data = node.data ?? {};
	if (Number.isSafeInteger(data.seq)) return data.seq;
	if (data.finalNode !== undefined && Number.isSafeInteger(data.finalNode.seq)) return data.finalNode.seq;
	return Number.isSafeInteger(node.anchorSeq) && node.anchorSeq >= 0 ? node.anchorSeq : undefined;
}

/**
 * Which durable seqs a set of tombstones hides.
 *
 * The transcript is built from **append-origin** events on purpose: a surface
 * replacement takes content out of the *model* history but deliberately leaves
 * the human transcript alone (the surface is the wrong source for it — a landed
 * replacement would silently erase rows the user already read). So the rows a
 * recall/delete removed have to be hidden here, derived from the durable
 * tombstones the Host wrote; otherwise the operation looks like it did nothing,
 * and does nothing again after every reload.
 *
 * @returns a predicate over one row's durable seq.
 */
function shadowRanges(notes) {
	const exact = new Set();
	const spans = [];
	for (const note of notes) {
		// The event's own `surfaceOp` endpoints are the authority on what was
		// shadowed; `source.removed` is a plugin-side supplement only.
		const from = Number.isSafeInteger(note.startSeq) ? note.startSeq : note.removed[0];
		const last = Number.isSafeInteger(note.endSeq) ? note.endSeq : note.removed[note.removed.length - 1];
		if (!Number.isSafeInteger(from)) continue;
		// A truncate hides everything from the target up to the tombstone, log-only
		// rows in that range included; a single removal hides only its own span.
		const open = note.action === "deleteFrom";
		spans.push({ from, to: open ? note.seq : last, open });
		for (const seq of note.removed) exact.add(seq);
	}
	return (seq) => seq !== undefined && (exact.has(seq) || spans.some((span) => (span.open ? seq >= span.from && seq < span.to : seq >= span.from && seq <= span.to)));
}

/** This plugin's tombstones, read back from the Session's own event window. */
function tombstonesOf(window) {
	const notes = [];
	for (const entry of window?.entries ?? []) {
		if (entry?.type !== "event" || entry.event?.type !== "user/message") continue;
		const event = entry.event;
		const op = event.surfaceOp;
		if (op === null || typeof op !== "object" || op.op !== "replace") continue;
		const source = event.data?.source;
		if (source?.kind !== "plugin" || source.plugin !== PLUGIN_ID) continue;
		notes.push({
			seq: event.seq,
			startSeq: Number.isSafeInteger(op.startSeq) ? op.startSeq : undefined,
			endSeq: Number.isSafeInteger(op.endSeq) ? op.endSeq : undefined,
			action: typeof source.action === "string" ? source.action : "delete",
			turn: Number.isSafeInteger(source.turn) ? source.turn : null,
			removed: Array.isArray(source.removed) ? source.removed.filter((seq) => Number.isSafeInteger(seq)) : [],
			kinds: Array.isArray(source.kinds) ? source.kinds : [],
			preview: typeof source.preview === "string" ? source.preview : "",
			truncated: source.truncated === true,
		});
	}
	return notes;
}

//#endregion

//#region DOM building

function button(table, label, options, onFire) {
	const node = document.createElement("button");
	node.type = "button";
	node.className = "dsh-mcr-btn";
	node.textContent = label;
	if (options?.danger === true) node.dataset.danger = "true";
	if (options?.armWith === undefined) {
		node.addEventListener("click", () => {
			if (!node.disabled) onFire();
		});
		return node;
	}
	// Destructive actions arm on the first click and fire on the second.
	let armed = false;
	let timer = 0;
	const disarm = () => {
		armed = false;
		delete node.dataset.armed;
		node.textContent = label;
	};
	node.addEventListener("click", () => {
		if (node.disabled) return;
		if (!armed) {
			armed = true;
			node.dataset.armed = "true";
			node.textContent = options.armWith;
			timer = window.setTimeout(disarm, 4000);
			return;
		}
		window.clearTimeout(timer);
		disarm();
		onFire();
	});
	return node;
}

function flashError(row, table, error) {
	row.querySelector(":scope > .dsh-mcr-error")?.remove();
	const box = document.createElement("div");
	box.className = "dsh-mcr-error";
	const key = `error.${String(error?.code ?? "")}`;
	box.textContent = table[key] ?? fill(table["error.generic"], { message: error?.message ?? String(error) });
	row.appendChild(box);
	window.setTimeout(() => box.remove(), 7000);
}

/** Add or refresh one row's hover action cluster. */
function decorateRow(row, target, table, onAct) {
	row.style.position = "relative";
	const tools = row.querySelector(":scope > .dsh-mcr-tools");
	// The label language is part of the signature: a locale switch must rebuild
	// the cluster, not leave the previous language glued to the row.
	const signature = `${String(target.seq)}:${target.recallable ? "r" : "d"}:${table === zh ? "zh" : "en"}`;
	if (tools !== null && tools.dataset.sig === signature) return;
	tools?.remove();

	const holder = document.createElement("div");
	holder.className = "dsh-mcr-tools";
	holder.dataset.sig = signature;
	if (target.recallable) holder.appendChild(button(table, table["action.recall"], undefined, () => onAct("recall", holder)));
	holder.appendChild(button(table, table["action.delete"], { danger: true, armWith: table["action.arm"] }, () => onAct("delete", holder)));
	holder.appendChild(button(table, table["action.deleteFrom"], { danger: true, armWith: table["action.arm"] }, () => onAct("deleteFrom", holder)));
	row.appendChild(holder);
}

/** One inline note marking where a tombstone removed content. */
function buildNote(note, table, onRedo, onCopy) {
	const box = document.createElement("div");
	box.className = "dsh-mcr-note";
	box.dataset.note = String(note.seq);
	box.dataset.action = note.action;

	const label = note.action === "recall" ? table["note.recall"] : note.action === "deleteFrom" ? table["note.deleteFrom"] : table["note.delete"];
	const text = document.createElement("span");
	text.className = "dsh-mcr-note-text";
	if (note.preview === "") {
		const kinds = note.kinds.map((kind) => table[`kind.${kind}`] ?? kind).join("、");
		text.textContent = kinds === "" ? label : `${label}（${kinds}）`;
	} else {
		const preview = `${note.preview.length > 120 ? `${note.preview.slice(0, 120)}…` : note.preview}${note.truncated ? table["note.truncated"] : ""}`;
		text.textContent = fill(table["note.with"], { label, preview });
	}
	box.appendChild(text);

	if (note.preview !== "") {
		if (note.action === "recall") {
			const redo = noteAction(table["action.redo"]);
			redo.addEventListener("click", () => {
				onRedo(note);
				redo.textContent = table["note.redone"];
			});
			box.appendChild(redo);
		}
		const copy = noteAction(table["action.copy"]);
		copy.addEventListener("click", () => {
			onCopy(note);
			copy.textContent = table["action.copied"];
			window.setTimeout(() => {
				copy.textContent = table["action.copy"];
			}, 1600);
		});
		box.appendChild(copy);
	}
	return box;
}

/** A quiet underlined text action inside a note row. */
function noteAction(label) {
	const node = document.createElement("button");
	node.type = "button";
	node.className = "dsh-mcr-note-act";
	node.textContent = label;
	return node;
}

/** Place a note after the last row of its own Turn, before the next Turn starts. */
function placeNote(flow, note, element) {
	let anchor = null;
	const children = [...flow.children];
	if (Number.isSafeInteger(note.turn)) {
		for (const row of children) {
			if (!row.classList.contains("dsh-mcr-note") && row.dataset?.chatTurn === String(note.turn)) anchor = row;
		}
		if (anchor === null) {
			for (const row of children) {
				const turn = Number(row.dataset?.chatTurn);
				if (Number.isSafeInteger(turn) && turn > note.turn) {
					anchor = row;
					break;
				}
			}
		}
	}
	if (anchor === null) {
		flow.appendChild(element);
		return;
	}
	let cursor = anchor;
	while (cursor.nextElementSibling !== null && cursor.nextElementSibling.classList.contains("dsh-mcr-note")) cursor = cursor.nextElementSibling;
	cursor.after(element);
}

//#endregion

//#region controller

/**
 * Headless session-scoped entry that owns row decoration and the note layer.
 * It renders nothing: its work is the DOM cluster it hangs on shipped rows.
 */
function RecallController({ sessionId, kit, inputActions, useChat, useSession }) {
	globalThis.__MCR_MOUNTED__ = BUILD;
	const order = useChat((snapshot) => snapshot.order);
	const nodes = useChat((snapshot) => snapshot.nodes);
	const running = useSession((snapshot) => snapshot.running);
	const [revision, bump] = useState(0);

	const sessions = kit?.sessions;
	const locale = kit?.locale;

	// Re-read the durable window when it publishes, and re-translate on a
	// locale switch (the DOM copy is built outside React's `t`).
	useEffect(() => {
		const source = eventSourceOf(sessions, sessionId);
		if (source === undefined) return undefined;
		return source.subscribe(() => bump((value) => value + 1));
	}, [sessions, sessionId]);
	useEffect(() => {
		if (locale?.subscribe === undefined) return undefined;
		return locale.subscribe(() => bump((value) => value + 1));
	}, [locale]);

	const table = tableFor(locale?.getLocale?.().active);

	const sync = useCallback(() => {
		if (typeof document === "undefined" || sessions === undefined) {
			// Never leave the hook undefined on a bail-out: "no snapshot" must mean
			// "this bundle is not running", not "it ran and gave up early".
			globalThis.__MCR_DEBUG__ = { build: BUILD, sessionId, blocked: sessions === undefined ? "no sessions service" : "no document" };
			return;
		}
		const byKey = new Map();
		// Every row's position in the flow, actionable or not: the log-only rows
		// (retry notice, turn error, action bar) are not deletable themselves, but a
		// truncate must still take them out of view with the content around them.
		const anchorByKey = new Map();
		for (const key of order) {
			const node = nodes.get(key);
			if (node === undefined) continue;
			if (Number.isSafeInteger(node.anchorSeq)) anchorByKey.set(key, node.anchorSeq);
			if (!ACTIONABLE.has(node.kind)) continue;
			const seq = seqOf(node);
			if (seq === undefined) continue;
			byKey.set(key, {
				seq,
				recallable: node.kind === "user" || node.kind === "steering",
				text: rowText(node.data?.content ?? node.data?.finalNode?.content),
			});
		}
		const notes = tombstonesOf(eventSourceOf(sessions, sessionId)?.getSnapshot());
		const shadowed = shadowRanges(notes);
		// Support hook: what this code actually saw on its last pass. When a
		// report says "hiding did not work", one `JSON.stringify(__MCR_DEBUG__)`
		// answers whether the tombstone arrived, what range it carries, and which
		// seq each row resolved to — without anyone guessing from a screenshot.
		const debug = { build: BUILD, at: Date.now(), sessionId, orderLength: order.length, notes: notes.map((note) => ({ seq: note.seq, action: note.action, startSeq: note.startSeq, endSeq: note.endSeq, removed: note.removed })), rows: [], hidden: 0 };
		globalThis.__MCR_DEBUG__ = debug;

		for (const flow of document.querySelectorAll("[data-chat-flow]")) {
			const rows = [...flow.querySelectorAll("[data-chat-flow-key]")];
			// A flow that shows no row of this Session belongs to another
			// Session (e.g. a Sidebar chat tab): leave it alone entirely.
			if (rows.length > 0 && !rows.some((row) => byKey.has(row.dataset.chatFlowKey))) continue;

			for (const row of rows) {
				const key = row.dataset.chatFlowKey;
				const anchor = anchorByKey.get(key);
				if (debug.rows.length < 300) debug.rows.push({ key, kind: row.dataset.chatFlowKind, turn: row.dataset.chatTurn, anchor, shadowed: shadowed(anchor) });
				if (shadowed(anchor)) {
					// Removed by a tombstone: out of the model history already, so out
					// of the transcript too. Only rows this code hid get un-hidden.
					debug.hidden += 1;
					row.hidden = true;
					row.dataset.mcrHidden = "1";
					row.querySelector(":scope > .dsh-mcr-tools")?.remove();
					continue;
				}
				if (row.dataset.mcrHidden === "1") {
					row.hidden = false;
					delete row.dataset.mcrHidden;
				}
				const target = byKey.get(key);
				if (target === undefined || running) {
					row.querySelector(":scope > .dsh-mcr-tools")?.remove();
					continue;
				}
				decorateRow(row, target, table, async (action, holder) => {
					holder.dataset.pinned = "true";
					try {
						await recallRpc({ sessionId, action, seq: target.seq });
						if (action === "recall" && target.text !== "") {
							inputActions?.setDraft(target.text);
							inputActions?.focus();
						}
					} catch (error) {
						flashError(row, table, error);
					} finally {
						delete holder.dataset.pinned;
					}
				});
			}

			const live = new Set(notes.map((note) => String(note.seq)));
			for (const stale of flow.querySelectorAll(".dsh-mcr-note")) {
				if (!live.has(stale.dataset.note)) stale.remove();
			}
			for (const note of notes) {
				if (flow.querySelector(`.dsh-mcr-note[data-note="${note.seq}"]`)) continue;
				placeNote(flow, note, buildNote(note, table, (item) => {
					inputActions?.setDraft(item.preview);
					inputActions?.focus();
				}, (item) => {
					try {
						navigator.clipboard?.writeText(item.preview);
					} catch {
						// No clipboard outside a secure context; the note already shows the text.
					}
				}));
			}

			// A Turn whose every message row went away keeps only its action bar
			// (projected from `turn/start`/`turn/end`, which are log-only). Reading
			// alone under the note it looks broken, so the bar leaves with the
			// content it belonged to — and comes back if the rows come back.
			const notesByTurn = new Set(notes.map((note) => (Number.isSafeInteger(note.turn) ? String(note.turn) : null)));
			const perTurn = new Map();
			for (const row of rows) {
				const turn = row.dataset.chatTurn;
				if (turn === undefined) continue;
				const group = perTurn.get(turn) ?? { tails: [], others: 0 };
				// Tails are collected whatever their visibility: one hidden by this
				// rule last round must be able to come back. Content rows only count
				// when visible, so a shadowed prompt does not keep the bar alive.
				if (row.dataset.chatFlowKind === "turn-tail") group.tails.push(row);
				else if (!row.hidden) group.others += 1;
				perTurn.set(turn, group);
			}
			for (const [turn, group] of perTurn) {
				const orphaned = group.others === 0 && group.tails.length > 0 && notesByTurn.has(turn);
				for (const tail of group.tails) {
					if (tail.dataset.mcrHidden === "1") continue;
					tail.hidden = orphaned;
				}
			}
		}
	}, [order, nodes, running, sessionId, sessions, table, inputActions, revision]);

	useEffect(() => {
		ensureStyle();
	}, []);

	// Decorate after React has committed the rows.
	useEffect(() => {
		const frame = requestAnimationFrame(sync);
		return () => cancelAnimationFrame(frame);
	}, [sync]);

	// Rows enter and leave through renders we do not own; watch the DOM, but
	// ignore the mutations this plugin makes itself.
	useEffect(() => {
		if (typeof MutationObserver === "undefined") return undefined;
		let queued = 0;
		const own = (node) => node.nodeType === 1 && (node.classList?.contains("dsh-mcr-tools") || node.classList?.contains("dsh-mcr-note") || node.classList?.contains("dsh-mcr-error"));
		const observer = new MutationObserver((records) => {
			const foreign = records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => !own(node)));
			if (!foreign || queued !== 0) return;
			queued = requestAnimationFrame(() => {
				queued = 0;
				sync();
			});
		});
		observer.observe(document.body, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
			if (queued !== 0) cancelAnimationFrame(queued);
		};
	}, [sync]);

	return null;
}

//#endregion

//#region plugin

const inject = ["slots", "locale", "sessions"];

function apply(ctx) {
	console.info(`[message-recall] client bundle ${BUILD}`);
	// One registration per page, whatever number of copies of this bundle get
	// fetched. A profile can mount the plugin through two Host rows (the package
	// name and an exact file URL), and each row contributes its own boot-graph
	// entry — a second `register` with the same entry id is a SlotCore throw, and
	// two controllers would fight over the same rows. The guard rides a global so
	// it holds across module instances.
	if (globalThis.__DSH_MESSAGE_RECALL_APPLIED__ === true) return;
	globalThis.__DSH_MESSAGE_RECALL_APPLIED__ = true;
	ensureStyle();
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "message-recall: dictionaries");

	const kit = {
		sessions: ctx.sessions,
		locale: ctx.locale,
	};

	ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
		name: "conversation.input.overlay",
		id: NS,
		order: 50,
		locale: NS,
		inject: () => ({ recallKit: kit }),
	}, (props) => React.createElement(RecallController, { ...props, kit: props.recallKit })), "message-recall: per-message recall and delete");
}

exports.apply = apply;
exports.inject = inject;
exports.BUILD = BUILD;
exports.eventSourceOf = eventSourceOf;
exports.recallRpc = recallRpc;
exports.seqOf = seqOf;
exports.shadowRanges = shadowRanges;
exports.tombstonesOf = tombstonesOf;
exports.tableFor = tableFor;
return module.exports;
} });
