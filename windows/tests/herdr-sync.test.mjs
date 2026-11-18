// herdr → island pills (src/island/herdr-sync.ts): the pure reconcile step.
// Fixtures follow `herdr pane list` / `herdr agent list` as herdr prints them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { herdrState, reconcile } from "../src/island/herdr-sync.ts";

const pane = (id, extra = {}) => ({ pane_id: id, workspace_id: id.split(":")[0], cwd: "/home/me", ...extra });
const panesOf = (...panes) => ({ id: "cli:pane:list", result: { panes } });
const agentsOf = (...agents) => ({ id: "cli:agent:list", result: { agents } });

const mainPill = () => ({
  id: "integration_claude", name: "Claude Code", color: "#F5F6F8", state: "working",
  stepIndex: 2, steps: ["Read", "Edit"], source: "claudeCode", isIntegration: false,
  sessionId: "sess-claude-1", finalLine: "done.",
});
const n8n = () => ({
  id: "integration_n8n", name: "n8n", color: "#F29B38", state: "idle",
  stepIndex: 0, steps: [], source: "n8n", isIntegration: true,
});

test("a pane with an agent is adopted as a herdr pill", () => {
  const panes = panesOf(
    pane("w2:p6", { agent: "opencode", agent_status: "working", terminal_title_stripped: "OC | backend" }),
    pane("w2:p9"), // a plain shell: no agent, no pill
  );
  const out = reconcile([], panes, null);
  assert.equal(out.length, 1);
  const [t] = out;
  assert.equal(t.id, "w2:p6");
  assert.equal(t.source, "herdr");
  assert.equal(t.name, "OC | backend");
  assert.equal(t.state, "working");
  assert.equal(t.color, "#4ADE80"); // OpenCode's catalog colour
  assert.deepEqual(t.steps, []);
  assert.equal(t.sessionCwd, "/home/me");
  assert.equal(t.isIntegration, false);
});

test("the name is the agent's name, else the pane label, else its title, else the agent", () => {
  const panes = panesOf(
    pane("w1:p1", { agent: "claude", label: "CHIEF", terminal_title_stripped: "title" }),
    pane("w1:p2", { agent: "codex", label: "CHIEF2" }),
    pane("w1:p3", { agent: "agy" }),
  );
  const agents = agentsOf({ pane_id: "w1:p2", agent: "codex", name: "reviewer", agent_status: "idle" });
  assert.deepEqual(reconcile([], panes, agents).map((t) => t.name), ["CHIEF", "reviewer", "agy"]);
});

test("every agent_status maps to its state", () => {
  const want = { working: "working", blocked: "approval", idle: "idle", done: "finished", unknown: "idle" };
  for (const [status, state] of Object.entries(want)) {
    assert.equal(herdrState(status), state, status);
    const out = reconcile([], panesOf(pane("w1:p1", { agent: "claude", agent_status: status })), null);
    assert.equal(out[0].state, state, status);
  }
  assert.equal(herdrState(undefined), "idle");
  assert.equal(herdrState("something-new"), "idle");
});

test("agent list status wins over the pane list's", () => {
  const panes = panesOf(pane("w1:p1", { agent: "claude", agent_status: "idle" }));
  const agents = agentsOf({ pane_id: "w1:p1", agent: "claude", agent_status: "blocked" });
  assert.equal(reconcile([], panes, agents)[0].state, "approval");
});

test("a session a hook pill already shows is not duplicated", () => {
  const tasks = [mainPill(), n8n()];
  const panes = panesOf(
    pane("w1:p4", { agent: "claude", agent_status: "working",
      agent_session: { agent: "claude", kind: "id", value: "sess-claude-1" } }),
    pane("w1:p5", { agent: "opencode", agent_status: "idle" }),
  );
  const out = reconcile(tasks, panes, null);
  assert.deepEqual(out.map((t) => t.id), ["integration_claude", "integration_n8n", "w1:p5"]);
  // The hook pill is left exactly as it was: steps, finalLine, state.
  assert.equal(out[0], tasks[0]);
  assert.deepEqual(out[0].steps, ["Read", "Edit"]);
  assert.equal(out[0].finalLine, "done.");
});

test("a hook pill naming the pane as its session also prevents a duplicate", () => {
  const hook = { ...mainPill(), id: "agent_codex", source: "agent", sessionId: "w3:p1" };
  const out = reconcile([hook], panesOf(pane("w3:p1", { agent: "codex" })), null);
  assert.deepEqual(out.map((t) => t.id), ["agent_codex"]);
});

test("a herdr pill whose session a hook pill picks up goes away", () => {
  const panes = panesOf(pane("w1:p4", { agent: "claude", agent_session: { value: "sess-claude-1" } }));
  const first = reconcile([], panes, null);
  assert.deepEqual(first.map((t) => t.id), ["w1:p4"]);
  const out = reconcile([mainPill(), ...first], panes, null);
  assert.deepEqual(out.map((t) => t.id), ["integration_claude"]);
});

test("an existing herdr pill keeps its steps, badge and final line; herdr sets the state", () => {
  const existing = {
    id: "w2:p6", name: "old", color: "#4ADE80", state: "working", stepIndex: 1, steps: ["Bash"],
    source: "herdr", isIntegration: false, pillBadge: "approval", finalLine: "line", sessionId: null,
  };
  const panes = panesOf(pane("w2:p6", { agent: "opencode", agent_status: "done", label: "new" }));
  const tasks = [existing];
  const [t] = reconcile(tasks, panes, null);
  assert.notEqual(t, existing);
  assert.equal(t.state, "finished");
  assert.equal(t.name, "new");
  assert.deepEqual(t.steps, ["Bash"]);
  assert.equal(t.stepIndex, 1);
  assert.equal(t.pillBadge, "approval");
  assert.equal(t.finalLine, "line");
  assert.equal(existing.state, "working", "the input task is not modified");
  assert.equal(tasks.length, 1);
});

test("an unchanged herdr pill comes back as the same object", () => {
  const panes = panesOf(pane("w2:p6", { agent: "opencode", agent_status: "idle", label: "x" }));
  const first = reconcile([], panes, null);
  const second = reconcile(first, panes, null);
  assert.equal(second[0], first[0]);
});

test("a herdr pill goes away when its pane closes, or its agent leaves", () => {
  const panes = panesOf(pane("w1:p1", { agent: "claude" }), pane("w1:p2", { agent: "opencode" }));
  const tasks = reconcile([n8n()], panes, null);
  assert.deepEqual(tasks.map((t) => t.id), ["integration_n8n", "w1:p1", "w1:p2"]);
  const closed = reconcile(tasks, panesOf(pane("w1:p2", { agent: "opencode" })), null);
  assert.deepEqual(closed.map((t) => t.id), ["integration_n8n", "w1:p2"]);
  const left = reconcile(closed, panesOf(pane("w1:p2")), null);
  assert.deepEqual(left.map((t) => t.id), ["integration_n8n"]);
  const none = reconcile(left, panesOf(), null);
  assert.deepEqual(none.map((t) => t.id), ["integration_n8n"]);
});

test("tasks from other sources are never touched, whatever herdr says", () => {
  const tasks = [mainPill(), n8n(), { ...n8n(), id: "agent_gemini", source: "agent", state: "error" }];
  const snapshot = structuredClone(tasks);
  const out = reconcile(tasks, panesOf(pane("w9:p1", { agent: "claude", agent_status: "working" })), null);
  assert.equal(out.length, 4);
  for (let i = 0; i < 3; i++) assert.equal(out[i], tasks[i]);
  assert.deepEqual(tasks, snapshot);
});

test("an unreadable pane list (herdr absent or failing) changes nothing", () => {
  const tasks = [mainPill(), { ...mainPill(), id: "w1:p1", source: "herdr", sessionId: null }];
  for (const bad of [null, undefined, "", 42, {}, { error: { code: "x" } }, { result: {} }, { result: { panes: "no" } }]) {
    assert.equal(reconcile(tasks, bad, null), tasks, JSON.stringify(bad));
  }
});

test("bare shapes are accepted too, and junk entries skipped", () => {
  const out = reconcile([], { panes: [null, 3, { agent: "claude" }, pane("w1:p1", { agent: "claude" })] }, [
    { pane_id: "w1:p1", agent_status: "working" },
  ]);
  assert.deepEqual(out.map((t) => [t.id, t.state]), [["w1:p1", "working"]]);
});
