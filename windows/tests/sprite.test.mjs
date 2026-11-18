// The FFBE sprite companion (src/mochi/sprite.ts): state → animation, frame
// timing, and reading /api/party + party.json. No network, no canvas.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  animForState, characterSetting, frameIndex, parseSpriteSet, spriteAnimates, spriteRect,
} from "../src/mochi/sprite.ts";

const anim = (sheet, frameW, frameH, count, fps) => ({ sheet, frameW, frameH, count, fps });

const API = {
  active: "regis",
  party: ["cloud", "regis"],
  slotCount: 5,
  members: [
    { id: "regis", character: "regis", name: "Regis", level: 3 },
    { id: "cloud", character: "cloud-ac", name: "Cloud", level: 9 },
  ],
};

// The same members with Cloud active: the tests below assert Cloud's animations.
const CLOUD = { ...API, active: "cloud", party: ["cloud"] };

const JSON_ = {
  characters: [
    {
      id: "cloud-ac", name: "Cloud", dir: "cloud ac", scale: 2, displayHeight: 140,
      animations: {
        idle: anim("idle.png", 300, 250, 4, 6),
        atk: anim("atk.png", 700, 460, 14, 12),
        win: anim("win.png", 450, 270, 5, 8),
        dead: anim("dead.png", 280, 150, 1, 1),
        magic_atk: anim("magic_atk.png", 400, 300, 10, 10),
        move: anim("move.png", 300, 250, 6, 8),
      },
    },
    { id: "regis", name: "Regis", dir: "regis", displayHeight: 120, animations: { idle: anim("idle.png", 100, 100, 2, 4) } },
  ],
};

// ── animForState ──────────────────────────────────────────────────────────────

test("every state maps to its animation", () => {
  const want = {
    idle: "idle", dizzy: "idle",
    working: "atk", thinking: "atk", searching: "atk", ratelimit: "atk", waiting: "atk",
    approval: "magic_atk", question: "magic_atk",
    finished: "win", done: "win", celebrate: "win",
    error: "dead", sleeping: "dead", asleep: "dead",
  };
  for (const [state, a] of Object.entries(want)) assert.equal(animForState(state), a, state);
});

test("an unknown state plays idle", () => {
  assert.equal(animForState("something-new"), "idle");
  assert.equal(animForState(""), "idle");
});

test("working falls back to magic_atk when the character has no atk", () => {
  const anims = { idle: {}, magic_atk: {}, win: {} };
  assert.equal(animForState("working", anims), "magic_atk");
  assert.equal(animForState("approval", anims), "magic_atk");
  assert.equal(animForState("finished", anims), "win");
});

test("with atk present, atk wins over magic_atk", () => {
  assert.equal(animForState("working", { idle: {}, atk: {}, magic_atk: {} }), "atk");
});

test("a missing animation falls back to idle", () => {
  const anims = { idle: {} };
  for (const s of ["working", "finished", "error", "sleeping"]) assert.equal(animForState(s, anims), "idle", s);
});

// ── frameIndex ────────────────────────────────────────────────────────────────

test("frames advance at fps and wrap around", () => {
  const a = { count: 4, fps: 6 };
  assert.equal(frameIndex(a, 0), 0);
  assert.equal(frameIndex(a, 166), 0);
  assert.equal(frameIndex(a, 167), 1);
  assert.equal(frameIndex(a, 500), 3);
  assert.equal(frameIndex(a, 667), 0); // 4 frames later: wrapped
  assert.equal(frameIndex(a, 1000), 2); // 6 frames → 6 % 4
});

test("fps sets the pace", () => {
  assert.equal(frameIndex({ count: 10, fps: 1 }, 2500), 2);
  assert.equal(frameIndex({ count: 10, fps: 10 }, 250), 2);
});

test("a single-frame animation is always frame 0", () => {
  for (const t of [0, 1, 999, 1e9]) assert.equal(frameIndex({ count: 1, fps: 1 }, t), 0);
});

test("bad timing never yields a frame out of range", () => {
  assert.equal(frameIndex({ count: 4, fps: 0 }, 5000), 0);
  assert.equal(frameIndex({ count: 4, fps: 6 }, -100), 0);
  assert.equal(frameIndex({ count: 4, fps: 6 }, NaN), 0);
  assert.equal(frameIndex({ count: 0, fps: 6 }, 5000), 0);
  for (let t = 0; t < 10_000; t += 37) {
    const i = frameIndex({ count: 7, fps: 13 }, t);
    assert.ok(i >= 0 && i < 7);
  }
});

// ── parseSpriteSet ────────────────────────────────────────────────────────────

test("the leader is the member Mission Control marks active", () => {
  const set = parseSpriteSet(API, JSON_, "http://host:1/");
  assert.equal(set.id, "regis");
  assert.equal(set.name, "Regis");
  assert.equal(set.displayHeight, 120);
  assert.deepEqual(Object.keys(set.anims), ["idle"]);
  assert.deepEqual(
    { ...set.anims.idle, url: undefined },
    { sheet: "idle.png", url: undefined, frameW: 100, frameH: 100, count: 2, fps: 4, image: null },
  );
});

test("a member's character field, not its id, names the sprite", () => {
  const api = { active: "cloud", party: ["cloud"], members: [{ id: "cloud", character: "cloud-ac", name: "Cloud" }] };
  const set = parseSpriteSet(api, JSON_, "http://host:1/");
  assert.equal(set.id, "cloud-ac");
  assert.equal(set.name, "Cloud");
  assert.equal(set.displayHeight, 140);
  assert.deepEqual(Object.keys(set.anims).sort(), ["atk", "dead", "idle", "magic_atk", "win"]);
  assert.equal(set.anims.atk.url, "http://host:1/static/companion/cloud%20ac/atk.png");
  assert.deepEqual(
    { ...set.anims.idle, url: undefined },
    { sheet: "idle.png", url: undefined, frameW: 300, frameH: 250, count: 4, fps: 6, image: null },
  );
});

test("a member without a character field uses its id", () => {
  const set = parseSpriteSet({ party: ["regis"], members: [{ id: "regis" }] }, JSON_);
  assert.equal(set.id, "regis");
  assert.deepEqual(Object.keys(set.anims), ["idle"]);
  assert.equal(set.anims.idle.url, "http://127.0.0.1:8811/static/companion/regis/idle.png");
});

test("without an active member, party[0] leads", () => {
  const set = parseSpriteSet({ party: ["regis", "cloud"], members: API.members }, JSON_);
  assert.equal(set.id, "regis");
});

test("anything missing gives null", () => {
  assert.equal(parseSpriteSet(null, JSON_), null);
  assert.equal(parseSpriteSet({ party: [] }, JSON_), null);
  assert.equal(parseSpriteSet({ party: ["nobody"] }, JSON_), null);
  assert.equal(parseSpriteSet(CLOUD, null), null);
  assert.equal(parseSpriteSet(CLOUD, { characters: "x" }), null);
  const noIdle = { characters: [{ id: "cloud-ac", animations: { atk: anim("atk.png", 1, 1, 1, 1) } }] };
  assert.equal(parseSpriteSet(CLOUD, noIdle), null);
  const badIdle = { characters: [{ id: "cloud-ac", animations: { idle: anim("idle.png", 0, 10, 2, 1) } }] };
  assert.equal(parseSpriteSet(CLOUD, badIdle), null);
});

test("an animation with bad geometry is dropped, the rest kept", () => {
  const j = structuredClone(JSON_);
  j.characters[0].animations.win.count = -1;
  delete j.characters[0].animations.atk.sheet;
  const set = parseSpriteSet(CLOUD, j);
  assert.deepEqual(Object.keys(set.anims).sort(), ["dead", "idle", "magic_atk"]);
  assert.equal(animForState("working", set.anims), "magic_atk");
  assert.equal(animForState("finished", set.anims), "idle");
});

// ── geometry and setting ──────────────────────────────────────────────────────

test("idle is 0.9 of the box tall, centred and bottom-aligned", () => {
  const set = parseSpriteSet(CLOUD, JSON_);
  const r = spriteRect(set, set.anims.idle, 200, 100);
  assert.ok(Math.abs(r.h - 90) < 1e-9);
  assert.ok(Math.abs(r.x + r.w / 2 - 100) < 1e-9);
  assert.ok(Math.abs(r.y + r.h - 100) < 1e-9);
});

test("a larger frame keeps idle's scale when it fits, shrinks when not", () => {
  const set = parseSpriteSet(CLOUD, JSON_);
  const fits = spriteRect(set, set.anims.dead, 200, 100);
  assert.ok(Math.abs(fits.h - 150 * (90 / 250)) < 1e-9);
  const big = spriteRect(set, set.anims.atk, 200, 100);
  assert.ok(big.w <= 200 + 1e-9 && big.h <= 100 + 1e-9);
  assert.ok(Math.abs(big.y + big.h - 100) < 1e-9);
});

test("the character setting reads unknown values as mochi", () => {
  // Sprite only: every stored value resolves to the sprite character, and
  // Mochi survives only as the render fallback when Mission Control is down.
  for (const v of ["sprite", "mochi", undefined, null, "", "ffbe", 1, {}]) {
    assert.equal(characterSetting(v), "sprite");
  }
});

// ── Blocked looks unlike working; idle keeps moving ──────────────────────────

test("blocked plays a different strip from working when the character has one", () => {
  const full = { idle: {}, atk: {}, magic_atk: {}, limit_atk: {}, win: {}, dead: {} };
  assert.equal(animForState("working", full), "atk");
  assert.equal(animForState("approval", full), "magic_atk");
  assert.notEqual(animForState("approval", full), animForState("working", full));
  assert.equal(animForState("approval", { idle: {}, atk: {}, limit_atk: {} }), "limit_atk");
  assert.equal(animForState("approval", { idle: {}, atk: {} }), "atk");
  assert.equal(animForState("approval", { idle: {} }), "idle");
});

test("limit_atk is only kept (and fetched) when there is no magic_atk", () => {
  const j = structuredClone(JSON_);
  j.characters[0].animations.limit_atk = anim("limit_atk.png", 1778, 1705, 8, 12);
  assert.equal(parseSpriteSet(CLOUD, j).anims.limit_atk, undefined);
  delete j.characters[0].animations.magic_atk;
  const set = parseSpriteSet(CLOUD, j);
  assert.equal(set.anims.limit_atk.url, "http://127.0.0.1:8811/static/companion/cloud%20ac/limit_atk.png");
  assert.equal(animForState("approval", set.anims), "limit_atk");
});

test("every state the island uses animates, except a one-frame strip", () => {
  const set = parseSpriteSet(CLOUD, JSON_);
  for (const s of ["idle", "working", "approval", "finished"]) assert.ok(spriteAnimates(set, s), s);
  assert.equal(spriteAnimates(set, "error"), false, "dead is a single frame");
});

test("the engine draws the strip of its state, and stays busy while it plays", async () => {
  const { BotEngine } = await import("../src/mochi/engine.ts");
  const set = parseSpriteSet(CLOUD, JSON_);
  for (const [name, a] of Object.entries(set.anims)) a.image = { name };
  const drawn = [];
  const ctx = { imageSmoothingEnabled: true, drawImage: (img) => drawn.push(img.name) };
  const engine = new BotEngine();
  engine.sprite = set;
  const want = { idle: "idle", working: "atk", approval: "magic_atk", finished: "win", error: "dead" };
  for (const [state, strip] of Object.entries(want)) {
    engine.setState(state);
    engine.draw(ctx, 100, 100);
    assert.equal(drawn.at(-1), strip, state);
  }
  engine.setState("idle");
  assert.equal(engine.busy, true, "idle has 4 frames: the loop keeps running");
  engine.sprite = null;
});
