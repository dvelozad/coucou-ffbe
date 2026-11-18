// The pill row grouped by herdr workspace (src/island/workspace-groups.ts),
// and the workspace fields herdr-sync puts on its tasks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByWorkspace, taskWorkspace } from "../src/island/workspace-groups.ts";
import { herdrWorkspaces, reconcile } from "../src/island/herdr-sync.ts";

const herdr = (id, extra = {}) => ({
  id, name: id, color: "#4ADE80", state: "idle", stepIndex: 0, steps: [],
  source: "herdr", isIntegration: false, workspace: id.split(":")[0], ...extra,
});
const service = (id, extra = {}) => ({
  id, name: id, color: "#F5F6F8", state: "idle", stepIndex: 0, steps: [],
  source: id === "integration_claude" ? "claudeCode" : "n8n", isIntegration: true, ...extra,
});
const ws = (id, label, number, focused = false) => ({ id, label, number, focused });
const shape = (g) => g.groups.map((x) => [x.key, x.label, x.count, x.blocked, x.tasks.map((t) => t.id)]);

test("tasks without a workspace go to the Services group, last", () => {
  const g = groupByWorkspace(
    [service("integration_claude"), herdr("w2:p1"), service("integration_n8n"), herdr("w3:p1")],
    [ws("w2", "EMAIL", 2), ws("w3", "TESSERA", 3)],
  );
  assert.equal(g.headers, true);
  assert.deepEqual(shape(g), [
    ["w2", "EMAIL", 1, false, ["w2:p1"]],
    ["w3", "TESSERA", 1, false, ["w3:p1"]],
    ["services", "Services", 2, false, ["integration_claude", "integration_n8n"]],
  ]);
});

test("a non-herdr task is a service even if it carries a workspace", () => {
  assert.equal(taskWorkspace(service("integration_claude", { workspace: "w2" })), null);
  // A herdr task without the field falls back to its pane id; an odd id is a service.
  assert.equal(taskWorkspace(herdr("w9:p1", { workspace: undefined })), "w9");
  assert.equal(taskWorkspace(herdr("pane-x", { workspace: undefined })), null);
});

test("workspaces are ordered by number, the focused one first", () => {
  const tasks = [herdr("w7:p1"), herdr("w2:p1"), herdr("w10:p1"), herdr("w3:p1")];
  const list = [ws("w2", "EMAIL", 2), ws("w3", "TESSERA", 3), ws("w7", "COUCOU", 5), ws("w10", "LAB", 4)];
  assert.deepEqual(groupByWorkspace(tasks, list).groups.map((x) => x.key), ["w2", "w3", "w10", "w7"]);
  list[2].focused = true;
  assert.deepEqual(groupByWorkspace(tasks, list).groups.map((x) => x.key), ["w7", "w2", "w3", "w10"]);
});

test("without herdr's list, the number comes from the id and the label from the task", () => {
  const g = groupByWorkspace([herdr("w10:p1"), herdr("w2:p1", { workspaceLabel: "EMAIL" })]);
  assert.deepEqual(g.groups.map((x) => [x.key, x.label]), [["w2", "EMAIL"], ["w10", "w10"]]);
});

test("a blocked session marks its workspace, and only it", () => {
  const g = groupByWorkspace(
    [herdr("w2:p1", { state: "working" }), herdr("w2:p2", { state: "approval" }), herdr("w3:p1", { state: "finished" })],
    [ws("w2", "EMAIL", 2), ws("w3", "TESSERA", 3)],
  );
  assert.deepEqual(g.groups.map((x) => [x.key, x.blocked]), [["w2", true], ["w3", false]]);
});

test("one workspace and no services: no header, the row stays as it is", () => {
  const g = groupByWorkspace([herdr("w2:p1"), herdr("w2:p2")], [ws("w2", "EMAIL", 2)]);
  assert.equal(g.headers, false);
});

test("no herdr at all: no header", () => {
  const g = groupByWorkspace([service("integration_claude"), service("integration_n8n")]);
  assert.equal(g.headers, false);
  assert.deepEqual(g.groups.map((x) => x.key), ["services"]);
});

test("one workspace plus a service pill draws headers", () => {
  assert.equal(groupByWorkspace([herdr("w2:p1"), service("integration_n8n")]).headers, true);
});

test("the focused pill is counted but not drawn; a focused main pill is not a visible service", () => {
  const tasks = [service("integration_claude"), herdr("w2:p1"), herdr("w2:p2")];
  const g = groupByWorkspace(tasks, [ws("w2", "EMAIL", 2)], "integration_claude");
  assert.equal(g.headers, false, "only one workspace in the row");
  const h = groupByWorkspace(tasks, [ws("w2", "EMAIL", 2)], "w2:p1");
  assert.deepEqual(shape(h)[0], ["w2", "EMAIL", 2, false, ["w2:p2"]]);
});

// ── herdr-sync: workspace and label on the task ──────────────────────────────

const panes = { result: { panes: [
  { pane_id: "w2:p6", workspace_id: "w2", agent: "opencode", agent_status: "working" },
  { pane_id: "w7:p1", agent: "claude", agent_status: "idle" },
] } };
const workspaces = { result: { workspaces: [
  { workspace_id: "w2", label: "EMAIL", number: 2, focused: false },
  { workspace_id: "w7", label: "COUCOU", number: 5, focused: true },
] } };

test("herdr's workspace list is read with its numbers and focus", () => {
  assert.deepEqual(herdrWorkspaces(workspaces), [
    { id: "w2", label: "EMAIL", number: 2, focused: false },
    { id: "w7", label: "COUCOU", number: 5, focused: true },
  ]);
  assert.deepEqual(herdrWorkspaces(null), []);
});

test("reconcile puts the workspace and its label on each herdr task", () => {
  const out = reconcile([], panes, null, workspaces);
  assert.deepEqual(out.map((t) => [t.id, t.workspace, t.workspaceLabel]), [
    ["w2:p6", "w2", "EMAIL"],
    ["w7:p1", "w7", "COUCOU"],
  ]);
  // No workspace list: the id stands in for the label.
  assert.deepEqual(reconcile([], panes, null).map((t) => t.workspaceLabel), ["w2", "w7"]);
  // A renamed workspace updates the task; an unchanged one keeps the same object.
  const again = reconcile(out, panes, null, workspaces);
  assert.equal(again[0], out[0]);
  const renamed = structuredClone(workspaces);
  renamed.result.workspaces[0].label = "MAIL";
  assert.equal(reconcile(out, panes, null, renamed)[0].workspaceLabel, "MAIL");
});

// ── The compact strip: minis in group order, and a tag naming the workspaces ──

test("the strip's minis follow the groups, services last; ungrouped keeps today's four", async () => {
  const { stripTasks, workspaceTags } = await import("../src/island/workspace-groups.ts");
  const tasks = [service("integration_claude"), service("integration_n8n"), herdr("w7:p1"), herdr("w2:p1", { state: "approval" }), herdr("w2:p2")];
  const list = [ws("w2", "EMAIL", 2), ws("w7", "COUCOU", 5, true)];
  const g = groupByWorkspace(tasks, list, "integration_claude");
  assert.deepEqual(stripTasks(g, []).map((t) => t.id), ["w7:p1", "w2:p1", "w2:p2", "integration_n8n"]);
  assert.deepEqual(workspaceTags(g), [
    { key: "w7", label: "COUCOU", blocked: false },
    { key: "w2", label: "EMAIL", blocked: true },
  ]);
  const flat = groupByWorkspace([service("integration_claude"), service("integration_n8n")], [], "integration_claude");
  const others = ["a", "b", "c", "d", "e"].map((id) => service(id));
  assert.deepEqual(stripTasks(flat, others).map((t) => t.id), ["a", "b", "c", "d"]);
  assert.deepEqual(workspaceTags(flat), []);
});
