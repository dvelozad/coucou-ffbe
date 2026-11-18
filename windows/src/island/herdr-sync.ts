// herdr as the source of truth for which agent sessions exist: every pane
// herdr sees an agent in becomes a pill (id = pane id, source "herdr"), with
// its state from herdr's `agent_status`, and goes away with its pane.
// Read-only: nothing here acts on a pane. A session a hook already shows
// (same session id) is left to its hook pill, and pills from any other source
// are never touched. herdr absent or failing: nothing changes.

import type { BotStateName } from "../core/layout";
import { Bridge, IS_TAURI } from "../core/bridge";
import { pillDefinition } from "../core/pills";
import { State, type AgentTask } from "../core/state";

export const HERDR_POLL_MS = 5000;
const NAME_MAX = 40;
const FALLBACK_COLOR = "#94A3B8";

/** herdr's lifecycle states → Mochi's. */
export function herdrState(status: unknown): BotStateName {
  switch (status) {
    case "working": return "working";
    case "blocked": return "approval";
    case "done": return "finished";
    default: return "idle";
  }
}

/** The catalog pill whose colour an agent kind wears. */
const KIND_PILL: Record<string, string> = {
  claude: "integration_claude",
  codex: "agent_codex",
  opencode: "agent_opencode",
  agy: "agent_antigravity",
  antigravity: "agent_antigravity",
  gemini: "agent_gemini",
  copilot: "agent_copilot",
  amp: "agent_amp",
  hermes: "agent_hermes",
  cursor: "agent_cursor",
};

export interface HerdrSession {
  pane: string;
  agent: string;
  name: string;
  state: BotStateName;
  sessionId: string | null;
  cwd: string | null;
  /** The workspace id ("w2"), from the pane id when herdr does not say. */
  workspace: string;
  /** Its label from `herdr workspace list` ("EMAIL"), else the id. */
  workspaceLabel: string;
}

/** One workspace from `herdr workspace list`. */
export interface HerdrWorkspace {
  id: string;
  label: string;
  number: number;
  focused: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The list under herdr's `{ result: { <key>: [...] } }`, a bare `{ <key> }`, or an array. */
function listOf(value: unknown, key: string): Obj[] | null {
  const inner = isObj(value) && isObj(value.result) ? value.result : value;
  const list = Array.isArray(inner) ? inner : isObj(inner) ? inner[key] : null;
  return Array.isArray(list) ? list.filter(isObj) : null;
}

/** `herdr workspace list` → its workspaces; [] when unreadable. */
export function herdrWorkspaces(value: unknown): HerdrWorkspace[] {
  const out: HerdrWorkspace[] = [];
  for (const w of listOf(value, "workspaces") ?? []) {
    const id = str(w.workspace_id);
    if (!id) continue;
    out.push({
      id,
      label: str(w.label) ?? id,
      number: typeof w.number === "number" && Number.isFinite(w.number) ? w.number : workspaceNumber(id),
      focused: w.focused === true,
    });
  }
  return out;
}

/** "w12" → 12; anything else sorts last. */
export function workspaceNumber(id: string): number {
  const m = /^w(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The agent sessions herdr reports, one per pane that hosts an agent. Null
 * when the pane list is unreadable (then nothing must change). The agent list
 * is optional: it adds a name and the freshest status when it has the pane.
 * The workspace list is optional too: it only names the workspaces.
 */
export function herdrSessions(panes: unknown, agents: unknown, workspaces?: unknown): HerdrSession[] | null {
  const paneList = listOf(panes, "panes");
  if (!paneList) return null;
  const byPane = new Map<string, Obj>();
  for (const a of listOf(agents, "agents") ?? []) {
    const id = str(a.pane_id);
    if (id) byPane.set(id, a);
  }
  const labels = new Map(herdrWorkspaces(workspaces).map((w) => [w.id, w.label]));
  const out: HerdrSession[] = [];
  const seen = new Set<string>();
  for (const p of paneList) {
    const pane = str(p.pane_id);
    if (!pane || seen.has(pane)) continue;
    const a = byPane.get(pane);
    const agent = str(a?.agent) ?? str(p.agent);
    if (!agent) continue;
    seen.add(pane);
    const workspace = str(p.workspace_id) ?? pane.split(":")[0];
    const session = isObj(a?.agent_session) ? a.agent_session : isObj(p.agent_session) ? p.agent_session : null;
    const name = str(a?.name) ?? str(p.label) ?? str(p.terminal_title_stripped) ?? agent;
    out.push({
      pane,
      agent,
      name: name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name,
      state: herdrState(a?.agent_status ?? p.agent_status),
      sessionId: str(session?.value),
      cwd: str(p.cwd) ?? str(a?.cwd),
      workspace,
      workspaceLabel: labels.get(workspace) ?? workspace,
    });
  }
  return out;
}

function newTask(s: HerdrSession): AgentTask {
  return {
    id: s.pane,
    name: s.name,
    color: pillDefinition(KIND_PILL[s.agent] ?? "")?.color ?? FALLBACK_COLOR,
    state: s.state,
    stepIndex: 0,
    steps: [],
    source: "herdr",
    isIntegration: false,
    sessionId: s.sessionId,
    sessionCwd: s.cwd,
    workspace: s.workspace,
    workspaceLabel: s.workspaceLabel,
  };
}

/**
 * The tasks once herdr's view is applied. Pure: neither the input array nor
 * its tasks are modified, and an unchanged task is returned as the same object.
 * - a pane with an agent becomes (or stays) a "herdr" task, id = pane id;
 * - an existing herdr task keeps its steps, badge, finalLine (and its diffs,
 *   which are kept by id) — herdr only sets name, state and cwd;
 * - a session a task from another source already shows (same sessionId, or
 *   the pane id as sessionId) is not duplicated, and a herdr task for it goes;
 * - a herdr task whose pane is gone (or no longer hosts an agent) goes;
 * - tasks from any other source are returned as they are, in place.
 * Unreadable `panes` returns `tasks` itself. `workspaces` only names them.
 */
export function reconcile(tasks: AgentTask[], panes: unknown, agents: unknown, workspaces?: unknown): AgentTask[] {
  const sessions = herdrSessions(panes, agents, workspaces);
  if (!sessions) return tasks;
  const hooked = new Set<string>();
  for (const t of tasks) if (t.source !== "herdr" && t.sessionId) hooked.add(t.sessionId);
  const live = new Map<string, HerdrSession>();
  for (const s of sessions) {
    if (hooked.has(s.pane) || (s.sessionId && hooked.has(s.sessionId))) continue;
    live.set(s.pane, s);
  }

  const out: AgentTask[] = [];
  for (const t of tasks) {
    if (t.source !== "herdr") {
      out.push(t);
      continue;
    }
    const s = live.get(t.id);
    if (!s) continue;
    live.delete(t.id);
    const sessionId = s.sessionId ?? t.sessionId ?? null;
    const cwd = s.cwd ?? t.sessionCwd ?? null;
    const same = t.name === s.name && t.state === s.state && (t.sessionId ?? null) === sessionId
      && (t.sessionCwd ?? null) === cwd && t.workspace === s.workspace && t.workspaceLabel === s.workspaceLabel;
    out.push(same ? t : {
      ...t, name: s.name, state: s.state, sessionId, sessionCwd: cwd,
      workspace: s.workspace, workspaceLabel: s.workspaceLabel,
    });
  }
  for (const s of live.values()) out.push(newTask(s));
  return out;
}

// ── Poller ────────────────────────────────────────────────────────────────────

let timer: number | null = null;
let busy = false;
let workspaceList: HerdrWorkspace[] = [];
let workspaceKey = "";

/** The workspaces as herdr last listed them (number, focus), for ordering the pills. */
export function herdrWorkspaceList(): readonly HerdrWorkspace[] {
  return workspaceList;
}

async function tick() {
  if (busy || State.paused) return;
  busy = true;
  try {
    const [panes, agents, workspaces] = await Promise.all([
      Bridge.herdrPanes(), Bridge.herdrAgents(), Bridge.herdrWorkspaces(),
    ]);
    if (panes == null) return;
    const list = herdrWorkspaces(workspaces);
    const key = JSON.stringify(list);
    const metaChanged = key !== workspaceKey;
    workspaceList = list;
    workspaceKey = key;
    const before = State.tasks;
    const next = reconcile(before, panes, agents, workspaces);
    if (next.length === before.length && next.every((t, i) => t === before[i])) {
      // Only the workspaces moved (focus, order): the pill row still regroups.
      if (metaChanged) State.notify();
      return;
    }
    const kept = new Set(next.map((t) => t.id));
    State.tasks = next;
    for (const t of before) {
      if (t.source === "herdr" && !kept.has(t.id)) State.clearSessionDiffs(t.id);
    }
    if (State.focusId && !kept.has(State.focusId)) State.focusId = State.mainPillId;
    State.notify();
  } finally {
    busy = false;
  }
}

/** Re-reads herdr now, after an action, instead of waiting for the next poll. */
export function refreshHerdrNow(): Promise<void> {
  return IS_TAURI ? tick() : Promise.resolve();
}

/** Mirrors herdr's agent panes into the island every few seconds. Once per window. */
export function startHerdrSync() {
  if (timer != null || !IS_TAURI) return;
  timer = window.setInterval(() => void tick(), HERDR_POLL_MS);
  void tick();
}
