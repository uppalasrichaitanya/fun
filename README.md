# Pocket Arcade

Ten tiny browser games built to be replayed compulsively. Static site, no accounts, no ads, no servers; it works offline after the first load.

Vite + TypeScript (strict), Canvas 2D, hand-written physics, WebAudio-synthesised sound (zero audio files).

```sh
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/
npm test           # unit tests (game logic, bots, Bid War rules engine, daily, Brain Lab levels)
npm run verify-levels  # run every Brain Lab level's stored solution 3x headlessly (also part of build)
npm run sim        # Bid War bot simulator; add -- --write to record results in config.ts
npm run packs      # download Pokemon / hero artwork into public/packs/ (needs network, run once)
```

Deploy `dist/` to any static host (Vercel, Netlify, GitHub Pages). Asset paths are relative, so it works from a sub-path too.

## Status

| Batch | Scope | State |
| --- | --- | --- |
| 1 | Engine, hub, shell, Stack, Draw a Perfect Circle, Odd Tile Out, Cursor Panic | Built, awaiting playtest |
| 2 | Merge Drop, Untangle (15 levels + endless), Rocket Lander (15 levels, all verified 3-star by autopilot) | Built, awaiting playtest |
| 3 | Grapple Swing, Sumo Blobs, Tiny Survivors, daily challenge, PNG share cards | Built, awaiting playtest |
| 4 | Bid War (all 6 sub-specs, 3 packs, pack scripts, bot simulator) + hub tabs | Built, awaiting playtest |
| 5 | Brain Lab shared systems + Light Bender (40), Maze Maker (30 + 10 defence), Wire It (30), Gravity Golf (40) | Built, awaiting playtest |
| 6 | Switchyard (36 + endless), Heist 15 (36), Firebreak (30), Bridge It (30) | Built, awaiting playtest |
| 7 | Rocket Builder, Micro Escape | Not started (cards on the hub) |

The hub has three tabs: Arcade, Brain Lab (cards show stars earned, e.g. "27 / 90 stars"), Play Together.
Games not built yet appear as compact "Coming soon" cards.

## Daily challenge and share cards

The hub's daily strip picks 3 of 10 arcade games each day (`engine/daily.ts`, #1 = 1 Jan 2026).
Every player gets the same seed for a game on a given day (`#/game/<id>/daily`); the first finished attempt
is official, later ones are practice. One official attempt per day keeps the streak alive.
The game-over panel's Image button renders a 1080x1080 PNG (`shell/share-card.ts`) from the final frame;
on touch devices it opens the share sheet, elsewhere it downloads.

## Brain Lab

Build-and-solve games. Each has chapter JSON files in `src/games/<id>/levels/`, a pure `logic.ts`
(the same rules run in the game, the verifier and the level generator) and a `verify.ts`.

```
src/engine/levels/   pack.ts (chapter files -> levels, schema check, dev error log)  schema.ts
                     progress.ts (stars per level under <id>:stars, versioned save, unlock rules, ?editor)
                     session.ts (pick level, finish -> stars panel with goals)  verify.ts (verifier contract)
src/engine/editor/   history.ts (100-step undo/redo)  grid.ts (snap placement, drag/tap/long-press/right-click)
                     ui.ts (toolbar buttons, inventory bar, budget meter)  panel.ts (?editor panel, JSON export)
src/games/brain-lab.ts      chapter manifest (level select without loading level data)
src/games/brain-verify.ts   all verifiers; used by scripts/verify-levels.ts and brain-verify.test.ts
scripts/gen-light-bender.ts  gen-maze-maker.ts (--check re-runs the best-length search)  gen-gravity-golf.ts
        gen-switchyard.ts (autopilot recording = solution)  gen-heist.ts (time-layered BFS bot)
        gen-firebreak.ts (annealed tool placement)  gen-bridge-it.ts (cheapest passing template design)
```

How each game's stored solutions are made:

| Game | Solution | Generator |
| --- | --- | --- |
| Switchyard | Timed switch flips `[t, node, f/h/r]` | Autopilot rollouts; its flip count is par |
| Heist 15 | Input recording `[frames, bits]` | BFS over (cell, time) with guard/camera/laser safety margins |
| Firebreak | Tool cells + timed rain drops | Barrier gaps seed a simulated-annealing search |
| Bridge It | Joints + beams | Templates (deck, over/under truss, cable fans, piers) x depth x material; cheapest that holds a 10% heavier vehicle; budget = cost / 0.6 |

Generators take `--ch N` and/or a level id (e.g. `2-7`) to rebuild just that part.

Levels unlock on 1 star (Maze Maker's defence chapter opens after puzzle 10). Add `?editor` to the URL
(before the `#`) to unlock everything and get the dev editor panel: paint tools, "build = solution", export JSON.

## Bid War

Two-player auction on one keyboard (touch buttons on tablets). It runs its own screens instead of the arcade shell:
`registry.ts` gives it an `app` loader plus a canvas `preview` for the hub card.

```
src/games/bid-war/
  rules.ts           pure deterministic state machine (actions in, events out, time via `tick`)
  pool.ts            seeded pool draw, pack validity checks, match codes
  scoring.ts         auto score, awards, Civil War, AI-judge prompt
  config.ts          tiers, purses, timings, music; simulator results at the top
  packs/*.json       card data (bundled, offline); *.overrides.json = editable fan ratings
  setup.ts auction-view.ts results.ts civil-war.ts share-image.ts   the screens
scripts/
  build-pokemon-pack.ts build-heroes-pack.ts   regenerate pack JSON + download artwork
  simulate-bid-war.ts                          1,000 bot auctions per configuration
```

Artwork is third-party, so `public/packs/` is gitignored: run `npm run packs` once before `npm run build`
on the machine that deploys. Without it, cards fall back to drawn initials art and everything still works.
The scripts use PokeAPI and the akabab Superhero API, falling back to their GitHub mirrors.

## Layout

```
src/
  main.ts              hash router (#/, #/game/<id>, #/game/<id>/daily), service worker registration
  hub/                 lobby with live attract-mode previews
  shell/               start / HUD / pause / game-over overlays, settings panel, share, confetti
  engine/
    loop.ts            120 Hz fixed timestep, accumulator, frame clamp (100 ms)
    host.ts            GameHost: owns canvas, input, audio bus, fx and loop for one game
    input.ts           unified pointer (mouse/touch/pen, multi-touch, coalesced) + keyboard
    audio.ts           WebAudio synth SFX presets, pentatonic helper, lookahead music sequencer
    particles.ts       struct-of-arrays pool, 600 max
    camera.ts          trauma shake (gradient noise), hit-stop and slow-mo time control
    floaters.ts        pooled floating text
    tween.ts           easings + tiny tween runner
    rng.ts             mulberry32 seeded RNG, string hash
    storage.ts         try/catch localStorage wrapper, keys under `pa:`
    scores.ts          best / plays / last 5 per game
    daily.ts           daily rotation, seeds, official results, streak
    settings.ts        volume, sfx, music, reduced motion, colour-blind assist
    canvas.ts          DPR-aware (capped at 2) canvas, 'fit' letterbox or 'fill'
    glow.ts            pre-rendered additive glow sprites (no per-frame shadowBlur)
    theme.ts           canvas mirror of styles/tokens.css
    types.ts           Game / GameContext contract
  games/<id>/          index.ts config.ts logic.ts render.ts (one lazy chunk per game)
  styles/              tokens.css, app.css
```

## Game contract

Each game's `index.ts` default-exports a factory returning a `Game` (`init`, `start(seed, {demo})`, `update(dt)`, `render(alpha)`, `pause`, `resume`, `destroy`, optional `debugInfo`). `start(seed, { demo: true })` runs the game's own autopilot. The shell uses it behind the start screen and the hub runs it in each card preview (30 fps, paused off-screen, full fps on hover). A run ends with `ctx.shell.gameOver({ score, stats, rank? }, delayMs)`.

## Debug

Press `F3` or add `?debug` to the URL (before the `#`) for FPS, entity counts, and collider outlines where a game has them. With `?debug`, `window.__pa` exposes the running host and shell for console poking.
