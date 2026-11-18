// The pill row, grouped by herdr workspace. Pure: the overview draws what this
// returns. herdr pills go under their workspace; every other pill (Claude Code,
// mail, Spotify…) goes in one final "Services" group, never by workspace.
// One workspace and no services, or no herdr at all: no headers, and the row
// is drawn exactly as before.

import type { AgentTask } from "../core/state";
import { t } from "../i18n/i18n";
import { workspaceNumber, type HerdrWorkspace } from "./herdr-sync";

export const SERVICES_KEY = "services";

export interface PillGroup {
  /** The workspace id ("w2"), or SERVICES_KEY. */
  key: string;
  kind: "workspace" | "services";
  label: string;
  /** Sessions in the group, the focused one included. */
  count: number;
  /** One of them waits for an answer (state "approval"). */
  blocked: boolean;
  /** The pills to draw: the group's tasks minus the focused one. */
  tasks: AgentTask[];
}

export interface PillGrouping {
  /** Draw a header per group; false keeps today's flat row. */
  headers: boolean;
  groups: PillGroup[];
}

/** The workspace a task belongs to, or null for a service pill. */
export function taskWorkspace(task: AgentTask): string | null {
  if (task.source !== "herdr") return null;
  if (task.workspace) return task.workspace;
  const m = /^(w\d+):/.exec(task.id);
  return m ? m[1] : null;
}

/**
 * Groups `tasks` for the pill row. `workspaces` (herdr's list) gives labels,
 * order and focus; `hide` is the focused task, counted but not drawn.
 * Order: the focused workspace first, then by number, then by id; Services last.
 */
export function groupByWorkspace(
  tasks: readonly AgentTask[],
  workspaces: readonly HerdrWorkspace[] = [],
  hide: string | null = null,
): PillGrouping {
  const meta = new Map(workspaces.map((w) => [w.id, w]));
  const byWs = new Map<string, PillGroup>();
  const services: AgentTask[] = [];
  let servicesBlocked = false;

  for (const t of tasks) {
    const ws = taskWorkspace(t);
    if (ws == null) {
      if (t.id === hide) continue;
      services.push(t);
      servicesBlocked ||= t.state === "approval";
      continue;
    }
    let g = byWs.get(ws);
    if (!g) {
      g = {
        key: ws, kind: "workspace",
        label: meta.get(ws)?.label ?? t.workspaceLabel ?? ws,
        count: 0, blocked: false, tasks: [],
      };
      byWs.set(ws, g);
    }
    g.count++;
    g.blocked ||= t.state === "approval";
    if (t.id !== hide) g.tasks.push(t);
  }

  const rank = (g: PillGroup) => meta.get(g.key)?.number ?? workspaceNumber(g.key);
  const focused = (g: PillGroup) => (meta.get(g.key)?.focused ? 0 : 1);
  const groups = [...byWs.values()].sort((a, b) =>
    focused(a) - focused(b) || rank(a) - rank(b) || a.key.localeCompare(b.key));

  if (services.length) {
    groups.push({
      key: SERVICES_KEY, kind: "services", label: t("Services"),
      count: services.length, blocked: servicesBlocked, tasks: services,
    });
  }
  const wsCount = byWs.size;
  return { headers: wsCount >= 2 || (wsCount >= 1 && services.length > 0), groups };
}

// ── The compact strip ─────────────────────────────────────────────────────────
// 288 × 32 px, with four 13 px mini-bots: no room for headers or pill labels.
// The minis follow the groups' order instead, and a small tag beside them
// names the workspaces in that order, a blocked one marked.

export const STRIP_MINIS = 4;

/** The tasks behind the compact strip's mini-bots: grouped order when grouped, else today's. */
export function stripTasks(grouping: PillGrouping, others: readonly AgentTask[]): AgentTask[] {
  if (!grouping.headers) return others.slice(0, STRIP_MINIS);
  return grouping.groups.flatMap((g) => g.tasks).slice(0, STRIP_MINIS);
}

export interface WorkspaceTag {
  key: string;
  label: string;
  blocked: boolean;
}

/** The strip's workspace tag, in group order; empty when the row has no headers. */
export function workspaceTags(grouping: PillGrouping): WorkspaceTag[] {
  if (!grouping.headers) return [];
  return grouping.groups
    .filter((g) => g.kind === "workspace")
    .map((g) => ({ key: g.key, label: g.label, blocked: g.blocked }));
}
