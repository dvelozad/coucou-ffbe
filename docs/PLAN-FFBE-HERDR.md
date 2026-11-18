# Plan — Coucou as an FFBE companion driven by herdr

Status: proposal, written before any code change.
Scope: the Tauri app in `windows/` (Windows + Linux) first, the macOS app in
`NotchBuddy/` second. English throughout, as requested.

## 1. What was asked

1. Replace the Mochi avatar with the FFBE sprites Mission Control already
   prepares, driven by the party leader: if Regis leads, Coucou is Regis.
2. Make Coucou's assistant work **in tandem with herdr** — herdr is where the
   agents actually live.
3. Make Coucou compatible with the rest of the personal workflow (mail, cluster
   jobs, the companion world, terminals, memory).
4. A complete re-design, with a written plan first.

## 2. What exists today (read, not assumed)

- Tauri app: `windows/src/` (TypeScript, Vite) + `windows/src-tauri/` (Rust) +
  `windows/hook/` (Rust `coucou-hook`, which receives agent hook events on
  stdin and forwards them to the app).
- Character: `windows/src/mochi/engine.ts` (1 376 lines, `BotEngine` with states,
  tweens, badges) and `windows/src/mochi/outfits.ts` (1 158 lines, `Canvas`
  drawing, `drawOutfitBehind/Front`). Mochi is drawn entirely in code.
- Sessions: `windows/src/core/state.ts` — `AgentTask` carries `id, name, color,
  state, steps, source ("claudeCode"|"n8n"|"agent"), sessionId, sessionCwd,
  pillBadge, finalLine`; `ApprovalInfo` carries the permission/question payload.
- Island UI: `windows/src/island/island.ts` (62 KB) with `hooks.ts` (26 KB) doing
  the hook-side state machine.
- **herdr exists, but shallowly**: `windows/src-tauri/src/herdr.rs` (191 lines)
  maps a session id to the pane it came from (`HERDR_PANE_ID`,
  `HERDR_BIN_PATH` forwarded by the hook), and `focus(session)` selects that pane
  ("Open terminal"). There is no pane listing, no state mirroring, no prompt
  sending, no spawning. `windows/hook/src/main.rs` only forwards those two env
  vars.
- Repo state: `main` is upstream plus one merge; no prior modifications.

## 3. Constraints that shape the plan

| Constraint | Consequence |
|---|---|
| **`cargo` is not installed on this laptop** (node/npm/python3 are) | TypeScript can be type-checked and unit-tested here (`npm ci`, `tsc`, `vitest`-style tests). Rust (`src-tauri`, `coucou-hook`) can be written and reviewed but **not compiled or run** until a Rust toolchain is installed. |
| `CLAUDE.md`: "The character is drawn in code (Canvas + TimelineView), no Rive/Lottie/images" | The sprite request **contradicts a standing rule**. We add a second renderer behind a setting instead of deleting the first, so the rule still holds for the shipping character. |
| `CLAUDE.md`: "Never restyle what already ships; existing views stay exactly as they are" | The requested redesign is an explicit override. We keep existing views reachable and add new ones, rather than rewriting the island wholesale. |
| Coucou is a **published App Store app** (bundle `fr.louisraille.NotchBuddy`, upstream author Louis Raillé) | FFBE art is Square Enix IP. **Sprites must never be committed to this repo nor shipped in a release.** They are fetched at runtime from the local Mission Control server. |
| herdr's JSON is a moving target (versioned CLI) | Every herdr call is optional and failure-tolerant: no herdr → Coucou behaves exactly as today. |

## 4. Architecture

Three layers, each independently useful.

### 4.1 Sprite companion (leader-driven)

- **No art in the repo.** New module `windows/src/mochi/sprite.ts` fetches
  `http://127.0.0.1:8811/api/party` (leader + members) and the sprite sheets from
  `http://127.0.0.1:8811/static/companion/<character>/<anim>.png`, using the
  geometry in `/api/party` → `party.json` (`frameW/frameH/count/fps`,
  `displayHeight`). If Mission Control is down, Coucou silently keeps Mochi.
- **Renderer, not a rewrite.** `BotEngine` keeps its state machine and tweens;
  only the draw call is swapped. Introduce
  `interface CharacterRenderer { draw(ctx, state, size, t) }` with
  `MochiRenderer` (today's code, untouched) and `SpriteRenderer` (new).
  State → animation: `idle`→`idle`, `working`→`atk`/`magic_atk` (slow), `done`→
  `win`, `error`→`dead`/`dying`, sleeping→`dead`. Missing animation → `idle`.
- **Leader binding**: leader = `party[0]` from `/api/party` (Mission Control
  already normalises this). Changing the leader in the Vortex changes Coucou on
  the next poll — no rebuild.
- **Setting**: `character: "mochi" | "sprite"`, default `mochi`. Sprite mode is
  local-only and documented as such.

### 4.2 herdr as the session source of truth

Today Coucou learns about a session only when that agent's hook fires, and the
pane mapping is a side note. Inverted:

- Extend `windows/src-tauri/src/herdr.rs` with a small, argv-only API:
  `panes()`, `agents()`, `focus(pane)`, `send(pane, text)`, `keys(pane, [...])`,
  `start(kind, cwd)`, `close(pane)` — each shelling `herdr` with the same
  name/path validation already used for `focus`.
- New `windows/src/island/herdr-sync.ts`: poll `herdr pane list` +
  `herdr agent list` every few seconds (only while the island is open or a
  session is active), reconcile into `State.sessions`:
  - adopt a pane with an agent as an `AgentTask` (`source: "herdr"`, id = pane
    id, state from `agent_status`),
  - keep hook-delivered detail (steps, diffs, `finalLine`) attached by
    `sessionId`,
  - drop a session when its pane disappears.
- **Conflict rule**: herdr wins for liveness (working/blocked/idle/done), hooks
  win for detail. A hook event for a pane herdr no longer knows about expires
  instead of lingering.
- **Actions in the notch** (each behind an explicit click, per `CLAUDE.md`):
  focus pane, send a typed prompt, answer a blocked agent (send keys/text),
  start a new agent, close. Approvals already flow through `ApprovalInfo`; the
  answer is delivered by `herdr agent prompt`/`send-keys` when the session lives
  in a herdr pane, otherwise the existing path is kept.

### 4.3 Services from Mission Control

New pollers under `windows/src/integrations/` (one file each, same shape as the
existing pollers) against the local dashboard:
mail (`/api/mail`), jobs (`/api/state.jobs`), herdr agents (`/api/agents`),
companion/world (`/api/world`), terminal (existing `/ws/term`). Each produces a
pill with counts; each is optional and degrades to "not configured".

Rationale for going through Mission Control rather than the services directly:
it already aggregates mail-hub, SLURM, herdr and the companion behind one HTTP
surface on `127.0.0.1:8811`, with the tailnet gate and the allowlists. Coucou
gains those without re-implementing five clients.

## 5. Data contracts

Mission Control (already live):

| call | gives |
|---|---|
| `GET /api/party` | `active`, `party[≤5]`, `members[]` with level/hp/xp/mood |
| `GET /static/companion/party.json` | per character: `displayHeight`, `animations{sheet,frameW,frameH,count,fps}` |
| `GET /api/agents` | herdr workspaces + panes with live state |
| `GET /api/world` | locations, stage campaign, battle |
| `GET /api/mail?role=inbox` | unread, awaiting reply |

herdr CLI (argv only, validated):

    herdr pane list | agent list | pane get <id> | pane read <id> --source recent-unwrapped
    herdr pane focus <id> | pane run <id> <text> | pane send-keys <id> <key>
    herdr agent start <name> --kind <kind> --pane <id> | agent prompt <target> <text>

## 6. Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| **P0** | Branch `ffbe-herdr`, this plan, `npm ci`, baseline `npm run build` + `npm test` green | Baseline recorded in the plan's commit message |
| **P1** | `sprite.ts` + renderer switch + leader binding + setting | With Mission Control up and Regis leading, the island draws Regis' idle strip and animates; switching the leader changes it without a rebuild; Mission Control down → Mochi, no error |
| **P2** | `herdr.rs` read API + `herdr-sync.ts` (read-only mirror) | A pane running agy/opencode appears in the island with the right state within one poll; closing the pane removes it; with herdr absent nothing changes |
| **P3** | herdr actions (focus, prompt, answer, start, close) | Answering a blocked pane from the notch unblocks it in the pane; every action is one explicit click |
| **P4** | Mission Control pollers (mail, jobs, companion) | Counts match `/api/mail`, `/api/state`, `/api/world` at the same moment |
| **P5** | Redesign pass on the island: pills grouped by herdr workspace, sprite-flavoured states, docs + CHANGELOG + what's new | Screenshots; existing views still reachable |

Verification per phase: `npm run build` (tsc + vite) and the JS test suite run
here; anything touching Rust is compiled only once a toolchain exists (see
Open questions). No phase ships FFBE art in git.

## 7. Risks

1. **IP exposure** — the sprite mode must stay local and opt-in; the App Store
   build keeps Mochi. If you ever want sprites in a release, that is a licensing
   question, not a technical one.
2. **Two sources of truth** (hooks + herdr). Mitigated by the conflict rule and
   by making herdr strictly optional.
3. **herdr CLI drift** — every call tolerates failure and missing fields; the
   app behaves as it does today without herdr.
4. **Rust unverified here** — the herdr Rust surface is the one part I cannot
   compile on this machine.

## 8. Decisions taken (2026-11-18)

1. **Rust toolchain installed** on this machine (`cargo 1.100.0`, rustup at
   `~/.cargo`). `cargo build --release -p coucou-hook` succeeds in ~19 s, so the
   herdr Rust work is buildable and testable here. The Tauri app itself needs the
   Linux webkit/gtk system packages, which need root (see 9).
2. **Sprite only.** The `character` setting no longer offers Mochi:
   `characterSetting()` resolves every stored value to `"sprite"`. Mochi's
   renderer stays in the code as the offline fallback — if Mission Control cannot
   be reached, the notch still shows a character rather than an empty box.
3. **herdr is called directly** by Coucou (not through Mission Control's
   `/api/herdr/*`), so the app works even if the dashboard is down; Mission
   Control is used only for the sprite assets and, later, the service pollers.

## 9. What the app build still needs

`cargo build -p coucou` runs the dependency download but the Tauri crate links
against the Linux webkit stack, which is not installed here. One command with
root fixes it (I cannot run sudo non-interactively):

    sudo pacman -S --needed webkit2gtk-4.1 gtk3 libsoup3 base-devel \
                          librsvg xdotool

Until that runs, `windows/src-tauri` compiles only in `cargo check` form and the
app cannot be launched; `coucou-hook` and the whole TypeScript layer are already
verified.

## 10. Open questions (these change the work, not just the polish)

1. **Install a Rust toolchain?** Without it, P2/P3 ship as reviewed-but-unbuilt
   Rust. With `rustup` + Tauri's Linux deps (~1–2 GB), I can build and test the
   whole app here.
2. **Should Coucou call herdr directly (proposed) or go through Mission
   Control's `/api/herdr/*`?** Direct keeps Coucou independent of the dashboard;
   via the dashboard reuses its allowlists and needs one client instead of eight.
3. **Default mode after this work**: Mochi with an opt-in sprite mode (proposed,
   safest), or sprite mode on by default in your local build?
