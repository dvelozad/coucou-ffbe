// A stand-in for Tauri in a plain browser, for the dev previews: every command
// answers from `answers` (or null), events can be fired with window.__emit.
// Not shipped in the app.
const listeners = new Map<string, (e: unknown) => void>();
const answers: Record<string, unknown> = (window as any).__answers ?? {};

// herdr, for the island preview: two workspaces, so the pill row shows its
// workspace headers. A page can still answer these itself through __answers.
const pane = (pane_id: string, agent: string | null, agent_status: string, title: string) => ({
  pane_id, workspace_id: pane_id.split(":")[0], agent: agent ?? undefined, agent_status: agent ? agent_status : undefined,
  terminal_title_stripped: title, cwd: "/home/deo/coucou-ffbe",
});
const herdrPanes = [
  pane("w2:p6", "opencode", "working", "OC | mail triage"),
  pane("w2:p2", "agy", "blocked", "AGY-WORKER"),
  pane("w7:p1", "claude", "idle", "FFBE-COUCOU"),
  pane("w7:p3", null, "", "zsh"),
];
answers.herdr_panes ??= { id: "cli:pane:list", result: { panes: herdrPanes } };
answers.herdr_agents ??= { id: "cli:agent:list", result: { agents: herdrPanes.filter((p) => p.agent) } };
answers.herdr_workspaces ??= {
  id: "cli:workspace:list",
  result: { workspaces: [
    { workspace_id: "w2", label: "EMAIL", number: 2, pane_count: 2, agent_status: "blocked", focused: false },
    { workspace_id: "w7", label: "COUCOU", number: 5, pane_count: 2, agent_status: "idle", focused: true },
  ] },
};
answers.herdr_screen ??= {
  text: "  Edit src/mail/triage.rs?\n\n  > 1. Yes\n    2. Yes, and don't ask again\n    3. No, tell agy what to do\n",
};
let cb = 0;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (callback: (e: unknown) => void) => {
    const id = ++cb;
    (window as any)[`_${id}`] = callback;
    return id;
  },
  invoke: async (cmd: string, args: any) => {
    if (cmd === "plugin:event|listen") {
      const fn = (window as any)[`_${args.handler}`] ?? args.handler;
      listeners.set(args.event, fn);
      return listeners.size;
    }
    if (cmd === "plugin:event|unlisten") return null;
    const a = answers[cmd];
    if (typeof a === "function") return (a as any)(args);
    return a ?? null;
  },
  metadata: { currentWindow: { label: "hub" }, currentWebview: { label: "hub", windowLabel: "hub" } },
};
(window as any).__emit = (event: string, payload: unknown) => listeners.get(event)?.({ event, id: 0, payload });
