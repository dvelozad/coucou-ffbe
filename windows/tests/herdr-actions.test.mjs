// herdr actions (src/island/herdr-actions.ts) and the herdr pane card
// (src/views/herdr.ts): what is offered, the exact command shown, and that
// nothing reaches herdr without an explicit click — Close takes two.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";

installFakeDom();

const {
  actionsFor, answerChoices, closeFires, closeStep, freePanes, replyText, screenTail, shellQuote,
  startCommand, validAgentName, validKind, REPLY_MAX,
} = await import("../src/island/herdr-actions.ts");
const { buildHerdrCard } = await import("../src/views/herdr.ts");

const herdrTask = (extra = {}) => ({
  id: "w2:p3", name: "AGY-WORKER", color: "#E879F9", state: "idle", stepIndex: 0, steps: [],
  source: "herdr", isIntegration: false, sessionId: null, sessionCwd: "/home/me", ...extra,
});

// ── actionsFor ────────────────────────────────────────────────────────────────

test("a task that is not a herdr pane gets no actions", () => {
  for (const source of ["claudeCode", "n8n", "agent"]) {
    assert.deepEqual(actionsFor(herdrTask({ source, id: "integration_claude" })), [], source);
  }
  assert.deepEqual(actionsFor(null), []);
  assert.deepEqual(actionsFor(undefined), []);
});

test("a herdr pane offers Focus, Reply, Close and New agent, each with its command", () => {
  const actions = actionsFor(herdrTask());
  assert.deepEqual(actions.map((a) => a.id), ["focus", "reply", "close", "start"]);
  const by = Object.fromEntries(actions.map((a) => [a.id, a.command]));
  assert.equal(by.focus, "herdr agent focus w2:p3");
  assert.equal(by.reply, "herdr pane run w2:p3 <text>");
  assert.equal(by.close, "herdr pane close w2:p3");
  assert.match(by.start, /^herdr agent start <name> --kind <kind> --pane/);
});

test("Answer is offered only while the agent is blocked, and reads the screen first", () => {
  for (const state of ["idle", "working", "finished", "error"]) {
    assert.ok(!actionsFor(herdrTask({ state })).some((a) => a.id === "answer"), state);
  }
  const answer = actionsFor(herdrTask({ state: "approval" })).find((a) => a.id === "answer");
  assert.equal(answer.command, "herdr pane read w2:p3 --source recent-unwrapped --lines 40");
});

test("commands quote what a shell would need quoted", () => {
  assert.equal(shellQuote("w2:p3"), "w2:p3");
  assert.equal(shellQuote("yes go"), "'yes go'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(startCommand("agy", "rev-1", "w1:p2"), "herdr agent start rev-1 --kind agy --pane w1:p2");
});

// ── answerChoices ─────────────────────────────────────────────────────────────

test("a blocked agent can be answered with Enter, Esc, y, n, or typed text", () => {
  const choices = answerChoices();
  const keys = choices.filter((c) => c.kind === "key").map((c) => c.key);
  for (const k of ["enter", "esc", "y", "n"]) assert.ok(keys.includes(k), k);
  assert.ok(choices.some((c) => c.kind === "text"));
  // Every key is one herdr.rs accepts: plain, never an option.
  for (const k of keys) assert.match(k, /^[a-z0-9][a-z0-9+_-]{0,31}$/);
});

test("the screen tail drops trailing blank lines and keeps the last ones", () => {
  assert.equal(screenTail("a\nb\nc\n\n  \n", 2), "b\nc");
  assert.equal(screenTail(null), "");
});

// ── validation ────────────────────────────────────────────────────────────────

test("agent names: lowercase first, then a–z 0–9 _ -, at most 31", () => {
  for (const ok of ["reviewer", "a", "rev-2", "x_y", "a".repeat(31)]) assert.ok(validAgentName(ok), ok);
  for (const bad of ["Reviewer", "reVIEW", "2fast", "9", "-x", "_x", "a b", "a.b", "a;b", "", "a".repeat(32), "é", null, 3]) {
    assert.ok(!validAgentName(bad), JSON.stringify(bad));
  }
});

test("kinds: only the offered ones", () => {
  for (const ok of ["claude", "agy", "opencode", "codex", "gemini"]) assert.ok(validKind(ok), ok);
  for (const bad of ["Claude", "bash", "", "claude ", "--kind", undefined]) assert.ok(!validKind(bad), String(bad));
});

test("reply text: trimmed, one line, refused when empty, capped", () => {
  assert.equal(replyText("  go ahead  "), "go ahead");
  assert.equal(replyText("two\nlines\there"), "two lines here");
  for (const empty of ["", "   ", "\n\t", null, undefined, 4]) assert.equal(replyText(empty), null);
  assert.equal(replyText("-rf /"), null, "a leading dash would be read as an option");
  assert.equal(replyText("x".repeat(5000)).length, REPLY_MAX);
  const wide = replyText("é".repeat(3000)); // 2 bytes each: the 4096-byte cap applies first
  assert.ok(new TextEncoder().encode(wide).length <= 4096);
});

// ── Close, in two steps ───────────────────────────────────────────────────────

test("close asks first: one tap never closes", () => {
  assert.equal(closeStep("idle", "ask"), "confirm");
  assert.equal(closeFires("idle", "ask"), false);
  for (const e of ["yes", "cancel", "settled"]) {
    assert.equal(closeStep("idle", e), "idle", e);
    assert.equal(closeFires("idle", e), false, e);
  }
});

test("from the question, Yes acts once, Cancel goes back", () => {
  assert.equal(closeStep("confirm", "yes"), "busy");
  assert.equal(closeFires("confirm", "yes"), true);
  assert.equal(closeStep("confirm", "cancel"), "idle");
  assert.equal(closeFires("confirm", "cancel"), false);
  assert.equal(closeStep("confirm", "ask"), "confirm");
  // While the call runs, nothing fires again; it settles back to idle.
  for (const e of ["ask", "yes", "cancel"]) {
    assert.equal(closeStep("busy", e), "busy");
    assert.equal(closeFires("busy", e), false);
  }
  assert.equal(closeStep("busy", "settled"), "idle");
});

test("free panes are the ones with no agent", () => {
  const panes = { result: { panes: [
    { pane_id: "w1:p1", agent: "claude" },
    { pane_id: "w1:p2", terminal_title_stripped: "zsh" },
    { pane_id: "w1:p3", agent: "", label: "spare" },
    { agent: "x" },
  ] } };
  assert.deepEqual(freePanes(panes), [{ pane: "w1:p2", label: "w1:p2 · zsh" }, { pane: "w1:p3", label: "w1:p3 · spare" }]);
  assert.deepEqual(freePanes(null), []);
});

// ── The card: nothing without a click ─────────────────────────────────────────

/** The refresh after an action reads herdr's lists; only the rest is an action. */
const READS = new Set(["herdr_panes", "herdr_agents", "herdr_workspaces"]);
const herdrCalls = () => calls.filter(([cmd]) => cmd.startsWith("herdr_") && !READS.has(cmd));
const settle = () => new Promise((r) => setImmediate(r));
const host = { keyboard() {}, holdOpen() {} };
const buttons = (card) => card.el.find("BUTTON");
const byText = (card, text) => buttons(card).find((b) => b.textContent === text);

let screenText = "Allow edit to main.rs? (y/n)";
const realInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const r = await realInvoke(cmd, args);
  return cmd === "herdr_screen" ? { text: screenText } : r;
};

beforeEach(() => {
  calls.length = 0;
});

test("rendering, re-syncing and a state change send nothing", async () => {
  const card = buildHerdrCard(host);
  card.sync(herdrTask());
  card.sync(herdrTask({ state: "approval" }));
  card.sync(herdrTask({ state: "working" }));
  card.sync(herdrTask({ state: "approval" }));
  // Pointing at a button only shows its command.
  byText(card, "Close").fire("mouseenter");
  assert.equal(card.el.querySelector(".herdr-cmd").textContent, "herdr pane close w2:p3");
  await settle();
  assert.deepEqual(herdrCalls(), []);
});

test("the command line shows Focus's command before anything is clicked", () => {
  const card = buildHerdrCard(host);
  card.sync(herdrTask());
  assert.equal(card.el.querySelector(".herdr-cmd").textContent, "herdr agent focus w2:p3");
});

test("Close needs a second, confirming click", async () => {
  const card = buildHerdrCard(host);
  card.sync(herdrTask());
  byText(card, "Close").fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), [], "the first click only asks");
  assert.ok(card.el.find(".herdr-ask").length === 1);
  byText(card, "Cancel").fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), []);
  assert.ok(byText(card, "Close"), "back to the buttons");

  byText(card, "Close").fire("click");
  byText(card, "Yes").fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), [["herdr_close", { pane: "w2:p3" }]]);
});

test("Answer reads the pane first; keys appear only then, one click each", async () => {
  const card = buildHerdrCard(host);
  card.sync(herdrTask({ state: "approval" }));
  byText(card, "Answer").fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), [["herdr_screen", { pane: "w2:p3", lines: 40 }]]);
  assert.equal(card.el.querySelector(".herdr-screen").textContent, screenText);
  calls.length = 0;
  const enter = byText(card, "Enter");
  enter.fire("mouseenter");
  assert.equal(card.el.querySelector(".herdr-cmd").textContent, "herdr pane send-keys w2:p3 enter");
  await settle();
  assert.deepEqual(herdrCalls(), [], "pointing at a key sends nothing");
  enter.fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), [["herdr_keys", { pane: "w2:p3", keys: ["enter"] }]]);
});

test("no key is offered when the screen could not be read", async () => {
  screenText = "";
  try {
    const card = buildHerdrCard(host);
    card.sync(herdrTask({ state: "approval" }));
    byText(card, "Answer").fire("click");
    await settle();
    assert.equal(card.el.querySelector(".herdr-keys").style.display, "none");
  } finally {
    screenText = "Allow edit to main.rs? (y/n)";
  }
});

test("Reply refuses empty text and sends the trimmed line on click", async () => {
  const card = buildHerdrCard(host);
  card.sync(herdrTask());
  byText(card, "Reply").fire("click");
  const field = card.el.querySelector(".herdr-field");
  const send = byText(card, "Send");
  field.value = "   ";
  send.fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), []);
  assert.match(card.el.querySelector(".herdr-note").textContent, /Nothing to send/);
  field.value = "  run the tests  ";
  field.fire("input");
  assert.equal(card.el.querySelector(".herdr-cmd").textContent, "herdr pane run w2:p3 'run the tests'");
  send.fire("click");
  await settle();
  assert.deepEqual(herdrCalls(), [["herdr_send", { pane: "w2:p3", text: "run the tests" }]]);
});

test("herdr's error is shown in the card, and the buttons come back", async () => {
  const before = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === "herdr_focus") {
      calls.push([cmd, args]);
      throw new Error("herdr agent focus: agent target w2:p3 not found");
    }
    return before(cmd, args);
  };
  try {
    const card = buildHerdrCard(host);
    card.sync(herdrTask());
    byText(card, "Focus").fire("click");
    await settle();
    assert.match(card.el.querySelector(".herdr-note").textContent, /not found/);
    assert.ok(buttons(card).every((b) => !b.disabled));
  } finally {
    internals.invoke = before;
  }
});
