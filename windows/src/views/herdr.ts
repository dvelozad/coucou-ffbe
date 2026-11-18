// The card of a herdr pane (source "herdr"): Focus, Reply, Answer, Close and
// New agent. Every action is one explicit click, and the exact command shows
// before it runs: the line under the buttons follows the pointer, and each form
// shows the command it is about to send. Nothing fires on render, on hover, on
// a state change or on a timer. Close asks first.
// Built once and synced in place, so a draft survives the 5 s poll.
// Words the app already translates go through t(); the herdr-only ones are
// English for now (a local, opt-in power feature).

import { h, clear, dot } from "./dom";
import { Bridge } from "../core/bridge";
import { t } from "../i18n/i18n";
import type { AgentTask } from "../core/state";
import {
  AGENT_KINDS, ANSWER_SCREEN_LINES, actionsFor, answerChoices, closeCommand, closeFires, closeStep,
  focusCommand, freePanes, keysCommand, replyCommand, replyText, screenTail, startCommand,
  validAgentName, validKind, type CloseEvent, type CloseStep, type HerdrActionId,
} from "../island/herdr-actions";
import { refreshHerdrNow } from "../island/herdr-sync";

export interface HerdrCardHost {
  /** The island takes the keyboard for a text field, and gives it back. */
  keyboard(on: boolean): void;
  /** Something is being typed: the island stays open until it is sent or cleared. */
  holdOpen(on: boolean): void;
}

const STATE_LABEL: Record<string, string> = {
  working: "working", approval: "blocked", finished: "done", idle: "idle",
};

type Panel = "none" | "reply" | "answer" | "start";

export function buildHerdrCard(host: HerdrCardHost) {
  let task: AgentTask | null = null;
  let panel: Panel = "none";
  let close: CloseStep = "idle";
  let busy = false;
  let error = "";
  let screen = "";
  let hoverCmd: string | null = null;
  let shownKey = "";

  const name = h("b");
  const meta = h("span");
  const head = h("div", { class: "int-head" }, name, meta);
  const row = h("div", { class: "int-actions herdr-actions" });
  const preview = h("div", { class: "herdr-cmd" });
  const body = h("div", { class: "herdr-panel" });
  const note = h("div", { class: "herdr-note" });
  const el = h("div", { class: "int-card herdr-card" }, head, row, body, preview, note);

  // Fields live across syncs so drafts survive the poll.
  const replyField = field("Reply to the agent…");
  const answerField = field("Type an answer…");
  const nameField = field("name, e.g. reviewer");
  const kindSelect = h("select", { class: "herdr-select" }) as HTMLSelectElement;
  for (const k of AGENT_KINDS) kindSelect.append(h("option", { value: k, text: k }));
  const paneSelect = h("select", { class: "herdr-select" }) as HTMLSelectElement;
  for (const f of [replyField, answerField, nameField]) {
    f.addEventListener("input", () => {
      host.holdOpen(f.value.trim().length > 0);
      live();
    });
  }
  for (const s of [kindSelect, paneSelect]) s.addEventListener("change", () => live());
  for (const f of [replyField, answerField]) {
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) sendReply(f);
    });
  }

  function field(placeholder: string): HTMLInputElement {
    const f = h("input", { class: "herdr-field", type: "text", placeholder, spellcheck: "false" }) as HTMLInputElement;
    f.addEventListener("focus", () => host.keyboard(true));
    // Released on blur too: a draft left behind must not pin the island open.
    f.addEventListener("blur", () => {
      host.keyboard(false);
      host.holdOpen(false);
    });
    f.addEventListener("keydown", (e) => e.stopPropagation());
    return f;
  }

  function button(label: string, command: string | null, onClick: () => void, kind = "secondary"): HTMLButtonElement {
    const b = h("button", { class: `btn ${kind} herdr-btn`, text: label }) as HTMLButtonElement;
    b.disabled = busy;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!busy) onClick();
    });
    if (command) {
      b.addEventListener("mouseenter", () => showCommand(command));
      b.addEventListener("focus", () => showCommand(command));
      b.addEventListener("mouseleave", () => showCommand(null));
    }
    return b;
  }

  function showCommand(command: string | null) {
    hoverCmd = command;
    preview.textContent = command ?? defaultCommand();
  }

  /** What the line under the buttons shows when nothing is pointed at. */
  function defaultCommand(): string {
    if (!task) return "";
    const pane = task.id;
    if (close === "confirm" || close === "busy") return closeCommand(pane);
    switch (panel) {
      case "reply": {
        const text = replyText(replyField.value);
        return text ? replyCommand(pane, text) : `herdr pane run ${pane} <text>`;
      }
      case "answer": {
        const text = replyText(answerField.value);
        return text ? replyCommand(pane, text) : "point at a key to see its command";
      }
      case "start": {
        const kind = kindSelect.value;
        const nm = nameField.value.trim() || "<name>";
        return startCommand(kind, nm, paneSelect.value || "<idle pane>");
      }
      default:
        return focusCommand(pane);
    }
  }

  /** Runs one herdr call: buttons off meanwhile, herdr's message shown if it fails. */
  async function act(run: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    busy = true;
    error = "";
    render();
    try {
      await run();
      after?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      render();
      void refreshHerdrNow();
    }
  }

  function setClose(event: CloseEvent) {
    const fires = closeFires(close, event);
    close = closeStep(close, event);
    if (!fires || !task) return render();
    const pane = task.id;
    void act(() => Bridge.herdrClose(pane), () => (panel = "none")).finally(() => {
      close = closeStep(close, "settled");
      render();
    });
  }

  function open(id: HerdrActionId) {
    if (!task) return;
    const pane = task.id;
    error = "";
    close = "idle";
    switch (id) {
      case "focus":
        panel = "none";
        void act(() => Bridge.herdrFocus(pane));
        return;
      case "close":
        panel = "none";
        setClose("ask");
        return;
      case "reply":
        panel = panel === "reply" ? "none" : "reply";
        break;
      case "answer":
        // Read first: the user sees the screen before any key is offered.
        panel = "answer";
        screen = "";
        void act(async () => {
          const r = await Bridge.herdrScreen(pane, ANSWER_SCREEN_LINES);
          screen = screenTail(r?.text);
        });
        return;
      case "start":
        panel = panel === "start" ? "none" : "start";
        if (panel === "start") {
          void act(async () => {
            const free = freePanes(await Bridge.herdrPanes());
            const keep = paneSelect.value;
            clear(paneSelect);
            for (const f of free) paneSelect.append(h("option", { value: f.pane, text: f.label }));
            if (free.some((f) => f.pane === keep)) paneSelect.value = keep;
            if (!free.length) error = "No idle pane: split one in herdr first.";
          });
          return;
        }
        break;
    }
    render();
  }

  function sendReply(f: HTMLInputElement) {
    const pane = task?.id;
    const text = replyText(f.value);
    if (!pane) return;
    if (!text) {
      error = "Nothing to send (empty, or starts with “-”).";
      return render();
    }
    void act(() => Bridge.herdrSend(pane, text), () => {
      f.value = "";
      host.holdOpen(false);
    });
  }

  // Each panel is built once; render() only swaps which one shows and what
  // depends on state, so a focused field is never taken out of the page.
  const replySend = button(t("Send"), null, () => sendReply(replyField), "primary");
  const replyBox = h("div", { class: "herdr-form" }, replyField, replySend);
  const screenPre = h("pre", { class: "herdr-screen" });
  const keys = h("div", { class: "herdr-keys" });
  const answerSend = button(t("Send"), null, () => sendReply(answerField), "primary");
  const answerForm = h("div", { class: "herdr-form" }, answerField, answerSend);
  const answerBox = h("div", {}, screenPre, keys, answerForm);
  const startBtn = button(t("Start"), null, () => startAgent(), "primary");
  const hint = h("div", { class: "herdr-hint", text: "a–z first, then a–z 0–9 _ -, at most 31" });
  const startBox = h("div", {},
    h("div", { class: "herdr-form" }, kindSelect, nameField),
    h("div", { class: "herdr-form" }, paneSelect, startBtn),
    hint,
  );
  let keysFor = "";

  function startAgent() {
    const kind = kindSelect.value;
    const nm = nameField.value.trim();
    const target = paneSelect.value;
    if (!validKind(kind) || !validAgentName(nm) || !target) return;
    void act(() => Bridge.herdrStart(kind, nm, target), () => {
      nameField.value = "";
      host.holdOpen(false);
      panel = "none";
    });
  }

  /** What follows typing: the command line, the Start button, the name hint. */
  function live() {
    const nm = nameField.value.trim();
    startBtn.disabled = busy || !(validKind(kindSelect.value) && validAgentName(nm) && !!paneSelect.value);
    hint.style.display = nm && !validAgentName(nm) ? "" : "none";
    preview.textContent = hoverCmd ?? defaultCommand();
  }

  function renderPanel() {
    const box = panel === "reply" ? replyBox : panel === "answer" ? answerBox : panel === "start" ? startBox : null;
    if (body.firstChild !== box) {
      if (document.activeElement && body.contains(document.activeElement)) host.keyboard(false);
      clear(body);
      if (box) body.append(box);
    }
    replySend.disabled = busy;
    answerSend.disabled = busy;
    if (panel === "answer" && task) {
      screenPre.textContent = screen || (busy ? "Reading the pane…" : "(empty)");
      screenPre.scrollTop = screenPre.scrollHeight;
      // No key until the screen has been read and shown.
      keys.style.display = screen ? "" : "none";
      answerForm.style.display = screen ? "" : "none";
      const key = `${task.id}~${busy}`;
      if (key !== keysFor) {
        keysFor = key;
        clear(keys);
        const pane = task.id;
        for (const c of answerChoices()) {
          if (c.kind === "key") {
            keys.append(button(c.label, keysCommand(pane, c.key), () => void act(() => Bridge.herdrKeys(pane, [c.key]))));
          }
        }
      }
    }
    live();
  }

  function render() {
    if (!task) return;
    const actions = actionsFor(task);
    // The buttons are rebuilt: whatever was pointed at is gone.
    hoverCmd = null;
    clear(row);
    if (close === "confirm" || close === "busy") {
      row.append(
        h("span", { class: "herdr-ask", text: "Really close?" }),
        button("Yes", closeCommand(task.id), () => setClose("yes"), "primary"),
        button(t("Cancel"), null, () => setClose("cancel")),
      );
    } else {
      for (const a of actions) {
        const b = button(a.label, a.command, () => open(a.id));
        b.classList.toggle("on", a.id === panel);
        row.append(b);
      }
    }
    // A panel whose action is no longer offered (the agent was answered) closes;
    // nothing is sent because of it.
    if (panel === "answer" && !actions.some((a) => a.id === "answer") && !busy) panel = "none";
    renderPanel();
    preview.textContent = hoverCmd ?? defaultCommand();
    note.textContent = error;
    note.classList.toggle("err", !!error);
  }

  return {
    el,
    sync(next: AgentTask) {
      if (next.id !== task?.id) {
        panel = "none";
        close = "idle";
        error = "";
        screen = "";
        hoverCmd = null;
        for (const f of [replyField, answerField, nameField]) f.value = "";
        host.holdOpen(false);
      }
      task = next;
      clear(head);
      head.append(dot(next.color, 7), name, meta);
      name.textContent = next.name;
      meta.textContent = `${STATE_LABEL[next.state] ?? next.state} · ${next.id}`;
      // The poll syncs every 5 s: only a change in the pane redraws the buttons.
      const key = `${next.id}~${next.state}~${next.name}`;
      if (key === shownKey) return;
      shownKey = key;
      render();
    },
  };
}
