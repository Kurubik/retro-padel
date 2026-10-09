# RETRO//PADEL — SIGNAL/09 handheld

A cyberpunk **handheld paddle duel** for the browser. One self-contained device: solo against three
CPU tiers, local two-player on a single keyboard or split touch zones, and private online 1v1 by
invite link with a real authoritative WebSocket server.

The console opens **powered on**. There is no landing page: an attract-mode rally runs behind the
menu and `PRESS START` is the first thing you can act on.

- **Mode:** first to 7, win by 2, sudden death at 10–10.
- **Serve:** alternates every point and is always shown explicitly.
- **Accounts:** none. No database, analytics, tracking, payments or third-party runtime services.

## Quick start

```bash
npm install
npm run dev            # Vite dev server (client only, 127.0.0.1:5173)

npm run typecheck      # TypeScript, strict, whole repo
npm test               # unit + protocol suites (Vitest)
npm run build          # client bundle (dist/) + Node server bundle (dist-server/)
npm start              # serve dist/ + WebSocket on :8080
npm run test:browser   # headless-Chrome acceptance run + screenshots
```

For a release, `npm run build && npm start` is all that is required: the server serves the built
client and hosts the realtime endpoint on the same origin.

## Controls

| Action | Keyboard | On the shell |
| --- | --- | --- |
| Player one move | `W` / `S` | D-pad up / down, or drag the screen |
| Player two move (local) | `↑` / `↓` | drag the right half of the screen |
| Serve · confirm | `Enter` / `A` | `A` |
| Pause · back | `Esc` / `B` | `B` |
| Cycle mode | `Shift` / `Tab` | `SELECT` |
| Confirm / start | `Enter` | `START` |

While a rally is live, dragging anywhere on the screen steers your paddle with pointer capture and
`touch-action: none`, so the page never scrolls under your thumb. Every touch target is at least
44 CSS px. A Gamepad API axis/hat is read as an optional extra and never replaces touch or keyboard.

## Team modes

- **SOLO / CPU** — three distinguishable opponents: `ROOKIE` (slow hands, big aiming error, visible
  hesitation), `PRO` (reads the angle, short reaction), `LEGEND` (full speed, predictive, almost no
  error).
- **LOCAL / 2P** — two independent paddles on one device: two keyboard columns, or two touch halves.
- **LINK / FRIEND** — create a room, share the 6-character code or the invite link, and play 1v1.
  Seats survive a refresh for 60 seconds through a cryptographic reconnect token.

## Architecture

```
shared/          framework-free simulation + wire protocol (no DOM, no network)
  core/          constants, seeded RNG, swept physics, match state machine, CPU policies
  protocol.ts    versioned message types + hostile-input parsing
server/          Node 22+ HTTP + WebSocket: authoritative 60 Hz room simulation, 20 Hz snapshots
client/          Vite + TypeScript UI: device shell, Canvas 2D field, DOM menus, Web Audio
deploy/          container + Caddy/rollback recipe (authored, not applied)
scripts/         browser acceptance harness
tests/           unit + protocol suites
artifacts/       screenshots produced by the browser harness
```

**Determinism.** The simulation is a pure function of `(state, inputs)` on a fixed 60 Hz step with a
seeded PRNG, so a match is replayable and the AI is unit-testable. Rendering interpolates state and
never feeds variable-delta physics.

**Collision.** The ball uses a swept circle-vs-AABB test (Minkowski expansion with slab clipping), so
a maximum-speed ball cannot tunnel through a paddle or a wall, and the bounce angle is derived from
the contact offset rather than from penetration depth.

**Authority.** In LINK mode the server owns score, ball and paddle positions. Clients only ever send
`{ seq, dir, serve }`; score, position and winner are server-only. Snapshots are broadcast at 20 Hz
and clients interpolate, predicting only their own paddle for input latency.

**Realtime protocol (`RP1`).** Versioned hello/room/state/event frames, 4 KB payload cap, token-bucket
rate limiting, bounded rooms, unambiguous 6-character codes (`ACDEFGHJKMNPQRTUVWXY34679` — no
`O/0`, `I/1/L`, `B/8`, `S/5`, `Z/2` look-alikes), 8-character-minimum random tokens via
`crypto.randomBytes`, and a 60-second grace window for reclaim. Every failure mode has explicit UI:
room not found, room full, bad token, room expired, opponent disconnected, reconnecting.

## Visual identity

SIGNAL/09 is an original industrial-hardware design, not a copy of any reference product: matte
structural black bezel with clipped 45° micro-corners inside a deeply rounded ceramic shell, exposed
copper trace, an ultraviolet anodised D-pad and face buttons, a diagonal light pipe, a CSS/SVG
speaker grille and chartreuse phosphor CRT.

**BLACKWALL / REDLINE** is the optional red-and-black console skin: graphite shell, crimson CRT,
red-lit controls, warning-stripe detail and a matching Canvas playfield. Switch it under
**SETTINGS → THEME**; the choice persists locally and SIGNAL/09 remains the default.

| Role | Token |
| --- | --- |
| Page void | `#080910` |
| Structural black | `#171823` |
| Ceramic shell | `#ECE8E4` |
| Deep violet | `#351B5C` |
| Control ultraviolet | `#9D62FF` |
| Phosphor screen | `#B8EF4A` |
| Dark screen ink | `#16241B` |
| Signal cyan | `#63E9E5` |
| Alert coral | `#FF6D70` |

Type is self-hosted (OFL): **Chakra Petch** for display and interface, **IBM Plex Mono** for scores and
telemetry. Fonts are bundled at build time — there is no runtime font CDN and no external request of
any kind.

Motion: a 660 ms power-on sweep, phosphor impact pings, LED state for serve/link, 90 ms button travel
and pointer-reactive stage lighting. The **settings screen** toggles theme, sound, motion and contrast; the
motion toggle and `prefers-reduced-motion` switch off the sweep, trail and pulses without touching
gameplay feedback, and contrast follows `prefers-contrast: more`.

Sound is synthesised locally with Web Audio, is **off until enabled** and never autoplays.

## Accessibility

- Real DOM menus with `role="listbox"`, `aria-selected`, focus-visible outlines and buttons that are
  genuinely clickable — no dead controls, and nothing decorative pretends to be interactive.
- Every state is reachable from the keyboard alone; the device legends carry navigation.
- Screen text remains high contrast in both themes; the `HIGH` contrast setting tightens it further.
- `aria-live` status text on the stage, and reduced-motion is respected by default.

## Scope

This is a fast two-paddle duel, not a padel rules simulation: no FIP scoring, 3D court, public
matchmaking, accounts, leaderboards or chat. Room state lives in memory only and dies with the room.
