// The FFBE sprite companion: the party leader from Mission Control (the local
// dashboard on 127.0.0.1:8811) drawn in Mochi's place. No art ships with
// Coucou: sheets are fetched at run time, and when the server is not there
// loadSprites gives null and Mochi stays.
// Each sheet is a single horizontal strip, frames left to right.

import type { BotStateName } from "../core/layout";

export type CharacterKind = "mochi" | "sprite";

export const CHARACTER_KINDS: readonly CharacterKind[] = ["mochi", "sprite"];

/** A value this build doesn't know reads as the default. */
export function characterSetting(value: unknown): CharacterKind {
  // Sprite only. Mochi is still drawn, but only as the offline fallback when
  // Mission Control cannot be reached — it is no longer a choice.
  void value;
  return "sprite";
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8811";
const TIMEOUT_MS = 2000;

/** The animations Coucou uses, in the order they are looked for. */
export const SPRITE_ANIMS = ["idle", "atk", "win", "dead", "magic_atk", "limit_atk"] as const;
export type SpriteAnimName = (typeof SPRITE_ANIMS)[number];

export interface SpriteAnim {
  sheet: string;
  /** Absolute URL of the sheet. */
  url: string;
  frameW: number;
  frameH: number;
  count: number;
  fps: number;
  /** Null until loaded (and in tests). */
  image: CanvasImageSource | null;
}

/** One character as party.json describes it. */
export interface SpriteChar {
  id: string;
  name: string;
  dir: string;
  scale: number;
  displayHeight: number;
  animations: Record<string, Omit<SpriteAnim, "url" | "image">>;
}

export interface SpriteSet {
  id: string;
  name: string;
  displayHeight: number;
  anims: { idle: SpriteAnim } & Partial<Record<Exclude<SpriteAnimName, "idle">, SpriteAnim>>;
}

// ── Pure parts ────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

function parseAnim(raw: unknown, base: string, dir: string): SpriteAnim | null {
  if (!isObj(raw) || typeof raw.sheet !== "string" || !raw.sheet) return null;
  const frameW = posNum(raw.frameW);
  const frameH = posNum(raw.frameH);
  const count = posNum(raw.count);
  if (frameW == null || frameH == null || count == null) return null;
  return {
    sheet: raw.sheet,
    url: `${base}/static/companion/${encodeURIComponent(dir)}/${encodeURIComponent(raw.sheet)}`,
    frameW,
    frameH,
    count: Math.floor(count),
    fps: posNum(raw.fps) ?? 1,
    image: null,
  };
}

/**
 * The leader's sprite set from `/api/party` and `party.json`, without images.
 * The leader is the member Mission Control marks `active` — the one its Camp
 * shows — falling back to `party[0]`. Its `character` names the entry in
 * party.json (the member id when it has none). Null when anything is missing,
 * including an idle animation.
 */
export function parseSpriteSet(partyApi: unknown, partyJson: unknown, baseUrl = DEFAULT_BASE_URL): SpriteSet | null {
  if (!isObj(partyApi) || !Array.isArray(partyApi.party)) return null;
  const members = Array.isArray(partyApi.members) ? partyApi.members : [];
  const findMember = (id: unknown) =>
    members.find((m): m is Record<string, unknown> => isObj(m) && m.id === id);
  const activeId = typeof partyApi.active === "string" && partyApi.active ? partyApi.active : null;
  const leader = findMember(activeId) ? activeId : partyApi.party[0];
  if (typeof leader !== "string" || !leader) return null;
  const member = findMember(leader);
  const charId = typeof member?.character === "string" && member.character ? member.character : leader;

  if (!isObj(partyJson) || !Array.isArray(partyJson.characters)) return null;
  const ch = partyJson.characters.find((c): c is Record<string, unknown> => isObj(c) && c.id === charId);
  if (!ch || !isObj(ch.animations)) return null;
  const dir = typeof ch.dir === "string" && ch.dir ? ch.dir : charId;
  const base = baseUrl.replace(/\/+$/, "");

  const anims: Partial<Record<SpriteAnimName, SpriteAnim>> = {};
  for (const name of SPRITE_ANIMS) {
    const a = parseAnim(ch.animations[name], base, dir);
    if (a) anims[name] = a;
  }
  if (!anims.idle) return null;
  // limit_atk is only a stand-in for magic_atk: its frames are huge (up to
  // ~1800 px), so a character drawn from them shrinks to a dot. Not fetched
  // when magic_atk is there.
  if (anims.magic_atk) delete anims.limit_atk;
  return {
    id: charId,
    name: typeof ch.name === "string" ? ch.name : charId,
    displayHeight: posNum(ch.displayHeight) ?? 120,
    anims: anims as SpriteSet["anims"],
  };
}

const WORK: readonly SpriteAnimName[] = ["atk", "magic_atk"];
/** Blocked looks unlike working: a spell (or a limit break) rather than the plain attack. */
const BLOCKED: readonly SpriteAnimName[] = ["magic_atk", "limit_atk", "atk"];

/** For each state, the animations it plays, in order of preference. */
const STATE_ANIMS: Record<string, readonly SpriteAnimName[]> = {
  idle: ["idle"],
  dizzy: ["idle"],
  working: WORK,
  thinking: WORK,
  searching: WORK,
  waiting: WORK,
  ratelimit: WORK,
  approval: BLOCKED,
  question: BLOCKED,
  finished: ["win"],
  done: ["win"],
  celebrate: ["win"],
  error: ["dead"],
  sleeping: ["dead"],
  asleep: ["dead"],
};

/**
 * Which animation a state plays: the first of its preferences the character
 * has (working: atk, else magic_atk; blocked: magic_atk, else limit_atk, else
 * atk), else idle. Without `anims` the first preference is returned.
 */
export function animForState(state: BotStateName | string, anims?: Partial<SpriteSet["anims"]>): SpriteAnimName {
  const prefs = STATE_ANIMS[state] ?? ["idle"];
  if (!anims) return prefs[0];
  return prefs.find((name) => anims[name]) ?? "idle";
}

/** The state's animation has more than one frame: the island must keep drawing. */
export function spriteAnimates(sprites: SpriteSet, state: BotStateName | string): boolean {
  const anim = sprites.anims[animForState(state, sprites.anims)] ?? sprites.anims.idle;
  return anim.count > 1 && anim.fps > 0;
}

/** The frame shown `tMs` into the animation, looping. */
export function frameIndex(anim: Pick<SpriteAnim, "count" | "fps">, tMs: number): number {
  const count = Math.max(1, Math.floor(anim.count));
  if (count === 1 || !(anim.fps > 0) || !(tMs > 0)) return 0;
  return Math.floor(tMs / (1000 / anim.fps)) % count;
}

/**
 * Where a frame goes in a `W`×`H` box: the idle frame is `H * 0.9` tall and the
 * other animations keep its scale (so the character keeps its size), shrunk
 * only when the frame would not fit. Centred, bottom-aligned.
 */
export function spriteRect(set: SpriteSet, anim: SpriteAnim, W: number, H: number) {
  const s = Math.min((H * 0.9) / set.anims.idle.frameH, H / anim.frameH, W / anim.frameW);
  const w = anim.frameW * s;
  const h = anim.frameH * s;
  return { x: (W - w) / 2, y: H - h, w, h };
}

// ── Canvas ────────────────────────────────────────────────────────────────────

/** Draws the frame for `state` at `tMs`. Clears nothing: the caller owns the canvas. */
export function drawSprite(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  sprites: SpriteSet, state: BotStateName | string, tMs: number,
) {
  const anim = sprites.anims[animForState(state, sprites.anims)] ?? sprites.anims.idle;
  if (!anim.image) return;
  const i = frameIndex(anim, tMs);
  const r = spriteRect(sprites, anim, W, H);
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(anim.image, i * anim.frameW, 0, anim.frameW, anim.frameH, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = smooth;
}

// ── Loading ───────────────────────────────────────────────────────────────────

function loadImage(url: string, signal: AbortSignal): Promise<CanvasImageSource | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok: boolean) => {
      signal.removeEventListener("abort", abort);
      resolve(ok ? img : null);
    };
    const abort = () => { img.src = ""; done(false); };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    signal.addEventListener("abort", abort);
    img.src = url;
  });
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/**
 * The party leader's sprites, images preloaded, or null on any failure (server
 * down, timeout, bad data, idle sheet that will not load). Never throws.
 * Outside a browser (Node) the geometry comes back with `image: null`.
 */
export async function loadSprites(baseUrl = DEFAULT_BASE_URL): Promise<SpriteSet | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const [api, json] = await Promise.all([
      getJson(`${base}/api/party`, ctrl.signal),
      getJson(`${base}/static/companion/party.json`, ctrl.signal),
    ]);
    const set = parseSpriteSet(api, json, base);
    if (!set) return null;
    if (typeof Image === "undefined") return set;
    const names = Object.keys(set.anims) as SpriteAnimName[];
    const images = await Promise.all(names.map((n) => loadImage(set.anims[n]!.url, ctrl.signal)));
    if (ctrl.signal.aborted) return null;
    names.forEach((n, k) => {
      if (images[k]) set.anims[n]!.image = images[k];
      else if (n !== "idle") delete set.anims[n];
    });
    return set.anims.idle.image ? set : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
