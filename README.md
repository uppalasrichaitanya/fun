# Pocket Arcade

Ten tiny browser games built to be replayed compulsively. Static site, no accounts, no ads, no servers; it works offline after the first load.

Vite + TypeScript (strict), Canvas 2D, hand-written physics, WebAudio-synthesised sound (zero audio files).

```sh
npm install
npm run dev        # local dev server
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/
```

Deploy `dist/` to any static host (Vercel, Netlify, GitHub Pages). Asset paths are relative, so it works from a sub-path too.

## Status

| Batch | Scope | State |
| --- | --- | --- |
| 1 | Engine, hub, shell, Stack, Draw a Perfect Circle, Odd Tile Out, Cursor Panic | Built, awaiting playtest |
| 2 | Merge Drop, Untangle, Rocket Lander | Not started |
| 3 | Grapple Swing, Sumo Blobs, Tiny Survivors, daily challenge, PNG share cards | Not started |

Games not built yet appear on the hub as compact "Coming soon" cards.

## Layout

```
src/
  main.ts              hash router (#/ and #/game/<id>), service worker registration
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
