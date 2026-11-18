// What the island offers for a herdr pane, and the exact command each runs.
// Pure: no DOM, no Tauri. The card (views/herdr.ts) only wires clicks to these
// decisions, and shows `command` before anything runs. Nothing here fires.
// The checks mirror herdr.rs so the card can refuse before the call.

import type { AgentTask } from "../core/state";
import { t } from "../i18n/i18n";

export type HerdrActionId = "focus" | "reply" | "answer" | "close" | "start";

export interface HerdrAction {
  id: HerdrActionId;
  label: string;
  /** The command that runs, as typed in a terminal. `<…>` is filled in by the form. */
  command: string;
}

export const ANSWER_SCREEN_LINES = 40;
export const REPLY_MAX = 2000;
/** herdr.rs refuses text over 4096 bytes. */
const REPLY_MAX_BYTES = 4096;
export const AGENT_KINDS = ["claude", "agy", "opencode", "codex", "gemini"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// ── Commands ──────────────────────────────────────────────────────────────────

/** A word as a POSIX shell would need it written; only for showing the command. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_:.+\/=-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

const cmd = (...argv: string[]) => ["herdr", ...argv.map(shellQuote)].join(" ");

export const focusCommand = (pane: string) => cmd("agent", "focus", pane);
export const replyCommand = (pane: string, text: string) => cmd("pane", "run", pane, text);
export const keysCommand = (pane: string, key: string) => cmd("pane", "send-keys", pane, key);
export const closeCommand = (pane: string) => cmd("pane", "close", pane);
export const screenCommand = (pane: string, lines = ANSWER_SCREEN_LINES) =>
  cmd("pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines));
export const startCommand = (kind: string, name: string, pane: string) =>
  cmd("agent", "start", name, "--kind", kind, "--pane", pane);

/**
 * The actions offered for one task: none unless it is a herdr pane. Answer only
 * while the agent is blocked (state "approval"). Reply and Start carry the
 * command with `<…>` where the form fills in.
 */
export function actionsFor(task: AgentTask | null | undefined): HerdrAction[] {
  if (!task || task.source !== "herdr" || !task.id) return [];
  const pane = task.id;
  const out: HerdrAction[] = [{ id: "focus", label: "Focus", command: focusCommand(pane) }];
  if (task.state === "approval") {
    out.push({ id: "answer", label: "Answer", command: screenCommand(pane) });
  }
  out.push(
    { id: "reply", label: t("Reply"), command: `herdr pane run ${shellQuote(pane)} <text>` },
    { id: "close", label: t("Close"), command: closeCommand(pane) },
    { id: "start", label: "New agent", command: "herdr agent start <name> --kind <kind> --pane <idle pane>" },
  );
  return out;
}

// ── Answer ────────────────────────────────────────────────────────────────────

export type AnswerChoice =
  | { kind: "key"; key: string; label: string }
  | { kind: "text"; label: string };

/** What a blocked agent can be answered with: one key per click, or a typed line. */
export function answerChoices(): AnswerChoice[] {
  return [
    { kind: "key", key: "enter", label: "Enter" },
    { kind: "key", key: "esc", label: t("Esc") },
    { kind: "key", key: "y", label: "y" },
    { kind: "key", key: "n", label: "n" },
    { kind: "key", key: "1", label: "1" },
    { kind: "key", key: "2", label: "2" },
    { kind: "key", key: "3", label: "3" },
    { kind: "key", key: "up", label: "↑" },
    { kind: "key", key: "down", label: "↓" },
    { kind: "text", label: "Type…" },
  ];
}

/** The last `lines` non-empty-trailing lines of a pane read, for the card. */
export function screenTail(text: unknown, lines = 12): string {
  if (typeof text !== "string") return "";
  const all = text.replace(/\r/g, "").split("\n");
  while (all.length && !all[all.length - 1].trim()) all.pop();
  return all.slice(-lines).join("\n");
}

// ── Validation ────────────────────────────────────────────────────────────────

const IDENT = /^[a-z][a-z0-9_-]{0,30}$/;

/** An agent name herdr.rs accepts: lowercase letter first, then [a-z0-9_-], ≤ 31. */
export function validAgentName(raw: unknown): raw is string {
  return typeof raw === "string" && IDENT.test(raw);
}

/** One of the kinds the Start form offers (and a valid identifier). */
export function validKind(raw: unknown): raw is AgentKind {
  return typeof raw === "string" && IDENT.test(raw) && (AGENT_KINDS as readonly string[]).includes(raw);
}

/**
 * The text a Reply sends, or null when there is nothing to send. Trimmed, on
 * one line (herdr.rs refuses control characters), capped at REPLY_MAX
 * characters and 4096 bytes. A leading "-" is refused, as in herdr.rs, since
 * herdr's own parser would read it as an option.
 */
export function replyText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (!text || text.startsWith("-")) return null;
  let chars = Array.from(text).slice(0, REPLY_MAX);
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  while (bytes(chars.join("")) > REPLY_MAX_BYTES) chars = chars.slice(0, -1);
  text = chars.join("").trimEnd();
  return text || null;
}

// ── Close, in two steps ───────────────────────────────────────────────────────

export type CloseStep = "idle" | "confirm" | "busy";
export type CloseEvent = "ask" | "yes" | "cancel" | "settled";

/**
 * Close never acts on one tap: "ask" only asks, "yes" from the question acts,
 * "cancel" goes back, and "settled" (the call returned) ends the wait.
 */
export function closeStep(step: CloseStep, event: CloseEvent): CloseStep {
  switch (step) {
    case "idle": return event === "ask" ? "confirm" : "idle";
    case "confirm": return event === "yes" ? "busy" : event === "cancel" ? "idle" : "confirm";
    case "busy": return event === "settled" ? "idle" : "busy";
  }
}

/** True only for the one transition that closes the pane. */
export function closeFires(step: CloseStep, event: CloseEvent): boolean {
  return step === "confirm" && event === "yes";
}

// ── Start ─────────────────────────────────────────────────────────────────────

export interface FreePane {
  pane: string;
  label: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Panes with no agent in them (`herdr pane list`), where Start can run one. */
export function freePanes(panes: unknown): FreePane[] {
  const inner = isObj(panes) && isObj(panes.result) ? panes.result : panes;
  const list = Array.isArray(inner) ? inner : isObj(inner) ? inner.panes : null;
  if (!Array.isArray(list)) return [];
  const out: FreePane[] = [];
  for (const p of list) {
    if (!isObj(p) || str(p.agent)) continue;
    const pane = str(p.pane_id);
    if (!pane) continue;
    const label = str(p.label) ?? str(p.terminal_title_stripped) ?? str(p.cwd) ?? "";
    out.push({ pane, label: label ? `${pane} · ${label}` : pane });
  }
  return out;
}
