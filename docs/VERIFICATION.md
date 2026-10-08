# Verification record — RETRO//PADEL

Everything below was executed against the **production build** (`dist/` + `dist-server/`) served by
the real Node server, not against a mocked environment. No deployment was performed.

## How to reproduce

```bash
npm ci
npm run typecheck                 # strict TypeScript, whole repository
npm test                          # 35 unit + protocol tests
npm run build                     # client bundle + Node server bundle
npm run test:browser              # headless Chrome acceptance run (writes artifacts/screenshots)
```

## Automated results

| Gate | Result |
| --- | --- |
| `tsc --noEmit` (strict) | clean |
| Vitest | **58 / 58 passing** across 7 files |
| Production build | client `dist/` + server `dist-server/index.js` |
| Browser acceptance | **27 / 27 checks passing** |

### Unit, protocol and HTTP coverage (`tests/`)

- **Physics** — no tunnelling at maximum ball velocity, wall bounces keep the ball in the field,
  paddle-corner bounce stays inside the speed cap, speed growth is capped over a 20 000-step volley,
  goals register only past the goal line.
- **Match flow** — countdown serves automatically offline, the explicit serve gate is honoured online
  and ignored from the receiving side, serves alternate after every point, win-by-2 at 7, no win at
  7–6, sudden death decided at 10–10, pause freezes the world.
- **CPU tiers** — profiles ordered rook/hard, every level stays inside the field, the sharper tier
  wins at least as many points, identical seeds replay identically, the softest tier visibly hesitates.
- **Room and reconnect** — 6-character codes from an unambiguous alphabet, deterministic mapping,
  48-hex-character tokens, two seats then a rejection, reclaim inside the grace window, wrong-token
  rejection, seat release and re-issue after expiry, drop pauses a live rally, rematch needs both
  players, token-bucket rate limiting, room cap, idle sweep.
- **Wire protocol** — version tag, well-formed frames, hostile value clamping, malformed / oversized /
  unknown frame rejection, identifier truncation.
- **Online lifecycle** (`tests/protocol/review-regressions.test.ts`) — sub-step intervals are accumulated
  rather than dropped, banked time is discarded while frozen and clamped so a stalled loop cannot
  fast-forward a rally, an active match is never expired by the idle sweep, an abandoned room still is,
  an automatic pause lifts on reclaim while a deliberate pause survives it, and a tab-away pause is
  reported as automatic.
- **Public HTTP surface** (`tests/integration/http.test.ts`) — this suite spawns the **built production
  bundle** (`dist-server/index.js`) on an ephemeral port and drives it over real sockets: health and the
  SPA shell, a malformed percent escape answered with 400 while `/healthz` keeps working afterwards,
  five hostile escapes, traversal attempts that never reach the source tree, an absurdly long path, and
  malformed WebSocket upgrade targets. It rebuilds the server bundle first when sources are newer.

### Browser acceptance (`scripts/browser-tests.mjs`)

Driven with headless Chrome against the built server:

1. `/healthz` responds.
2. Attract shows `PRESS START`; mode select lists solo, local, link, how-to and settings.
3. Settings exposes sound, motion and contrast.
4. **Solo** — a rally played with real keyboard events scores a point (observed up to 24 paddle hits).
5. **Game over** — winner plate and rematch control render.
6. **Pause** — resume / settings / quit render.
7. **Local 2P** — `W` moves P1 to the top and `↓` moves P2 to the bottom independently.
8. **Touch** — a touch drag on a 390×844 viewport moves the paddle.
9. **320×640** — no horizontal overflow, and every control is ≥ 44 CSS px in both axes.
10. **844×390 landscape** — screen and D-pad remain inside the viewport with no page scroll.
11. **LINK** — two separate browser contexts join one room over a real WebSocket, play, and score a
    point; both clients agree on the score; a page refresh reclaims the same seat using the stored
    reconnect token.
12. **LINK reconnect** — a live rally is dropped mid-play, the seat reclaims, and both clients return to
    a running rally on the `playing` screen without anyone pressing resume.
13. No console errors on any page.

## Screenshots

`artifacts/screenshots/` — 22 images at 1440×900, 390×844, 320×640 and 844×390 covering attract,
mode select, settings, how-to, solo rally, local rally, pause, winner, link lobby (host and both
players), live link match and reconnect.

## Capture note

All screenshots use `deviceScaleFactor: 2`. At scale factor 1 this headless Chrome build
intermittently composites the full-page screenshot with neighbouring text ghosted over the console
(highest impact on the wide desktop layout). It is a capture-pipeline artifact, not a page defect:
the same page renders clean at scale factor 2, and a clipped capture of the console region at scale
factor 1 is clean as well. The first version of the CRT overlay did use `mix-blend-mode`, which
produced a similar ghosting from a genuine cause; that was replaced with deterministic alpha
compositing before this run.

## Known, intentional behaviour

- On 320×640 and 844×390 the **mode list** scrolls inside its own body so headings and key hints stay
  fixed. Five 44 px rows do not fit the remaining height on those viewports, and shrinking the touch
  targets was rejected.
- The attract and menu screens show a **dimmed demo rally** behind the interface. The score readout is
  suppressed on menu screens so it cannot compete with interface copy, and kept on attract, pause and
  winner screens where it carries meaning.
- Rooms are in-memory only; a server restart ends in-flight rooms and clients surface it as
  `LINK LOST` with a 60-second reclaim attempt.

## Not verified here

- Real multi-device/real-network latency behaviour (the LINK checks use two browser contexts on one
  host, over a real WebSocket connection to the real server).
- Gamepad hardware (the Gamepad API path is implemented but was not exercised with a physical pad).
- Audio output (Web Audio is exercised only for absence of errors; it is muted until enabled).
- Container build/run and the Caddy cutover — see `deploy/README.md`. Neither was executed.
