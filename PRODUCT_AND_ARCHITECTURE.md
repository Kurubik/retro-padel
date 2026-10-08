# RETRO//PADEL — product, visual and engineering contract

## Intent and boundaries

Replace the experience at `https://padel.xtr.sh` with a new, original, immediately playable cyberpunk **paddle arcade**. This is deliberately not a simulation of regulation padel: it is a precise, fast, two-paddle duel inspired by the supplied handheld-console photograph. Preserve the silhouette and directness of a retro device, not its exact artwork, labels or proportions. The existing PADEL//CLUB source at `Kurubik/padel` and its running container must remain untouched and available for rollback. All new source, documentation and deployment recipe belong in `Kurubik/retro-padel`.

## Product flow

The public URL opens directly on the powered-on device, with a moving attract-mode ball and a clearly legible `PRESS START` action. No generic landing page before the game. `SELECT` cycles modes; `START` confirms. Modes: **SOLO / CPU** (three meaningful AI levels), **LOCAL / 2P** (two keyboards or split touch zones), and **LINK / FRIEND** (private 1v1 room by copyable invite URL or short room code). A concise how-to overlay, accessible settings (sound, motion, contrast), pause, rematch and return-to-menu are reachable from the device controls and keyboard. The device is attractive even before interaction; every decorative control either works or is visually marked decorative.

The match is first to 7, win by 2, with a final sudden-death point at 10–10 so sessions remain short. Serve alternates after each point. Score and serve owner are always explicit. A match state machine has `attract`, `mode-select`, `lobby`, `countdown`, `rally`, `point`, `paused`, `game-over` and `reconnecting`; no silent state transitions. Offline play works without network; online play degrades with a clear reconnection/expiration message rather than leaving a frozen ball.

Controls: desktop player one `W/S` or pointer/touch drag on the left side; player two `↑/↓` or drag on the right side in local mode. `Enter`/A serves and confirms, `Escape`/B pauses or backs out. A working touch D-pad plus A/B and START/SELECT are visible on narrow screens. Touch targets are at least 44 CSS px, use pointer capture, prevent accidental page scroll while dragging, and never require hover. An optional Gamepad API mapping is welcome but cannot replace touch/keyboard. Sound is synthesized locally with Web Audio only after a user gesture, muted by default until enabled; no autoplay audio. Settings persist in `localStorage`, while online room state lives only in memory.

## Visual identity — SIGNAL/09 handheld

This must look like a designed object, not a dashboard around a canvas. The screen is the hero and the machine is the interface. The visual tension is **military-industrial hardware x glowing arcade phosphor**: matte black titanium structural bezel, pale ceramic lower shell, ultraviolet anodized controls, thin exposed copper traces, high-voltage chartreuse display. Avoid stock cyberpunk skylines, generic glass cards, random neon gradients, huge bloom, unreadable pixel fonts or an emoji as the game ball.

Use these exact design tokens as a starting baseline, adjusting only for contrast and polish:

| Role | Token |
| --- | --- |
| Page void | `#080910` |
| Device structural black | `#171823` |
| Ceramic shell | `#ECE8E4` |
| Deep violet | `#351B5C` |
| Control ultraviolet | `#9D62FF` |
| Phosphor screen | `#B8EF4A` |
| Dark screen ink | `#16241B` |
| Signal cyan | `#63E9E5` |
| Alert coral | `#FF6D70` |

The design language uses clipped 45-degree micro-corners within an otherwise deeply rounded console, 1 px technical rules, tiny serial/type labels, off-center orange/cyan status LEDs and a diagonal light pipe linking screen and controls. The machine has shallow, plausible depth, a true inset shadow around the screen, selective specular rim highlights and a speaker grille made with CSS/SVG—not a flat rectangle with buttons. The playable field is a restrained lime monochrome CRT with crisp dark paddles/ball, faint scanlines, subtle persistence trail and a tiny pixel-grid/parallax effect. Gameplay remains readable at normal brightness and `prefers-reduced-motion`.

Layout: on 390×844 portrait, the console should nearly fill width yet fit key controls above the fold; screen aspect near 1:1.12 and a compact control deck beneath. On desktop the device centers at a readable size with an asymmetric technical rail for mode/status/help, not a stretched mobile screenshot. On landscape phone, switch to a wide device arrangement so the playfield and controls remain visible without clipping. On 320×640, scrolling may be used for non-game menus but active play must stay operable. Respect safe areas. Test 320×640, 390×844, 844×390 and 1440×900.

Typography: self-host OFL-licensed `Chakra Petch` (display/interface) and `IBM Plex Mono` (scores/telemetry) if practical; no runtime font CDN. Use readable system fallbacks. The main score must be instantly legible; microcopy can be small but never carry essential instructions alone. The device's own high-contrast legends carry navigation. Brand text `RETRO//PADEL`, subsystem label `SIGNAL/09`, small version line, and a compact `LINK ACTIVE` motif give it identity without implying official padel rules.

Motion hierarchy: an intentional 500–700 ms power-on sweep on first load, a brief phosphor ping for impact/score, LED pulse that reflects serve/connection, tactile 70–120 ms button travel, and subtle cursor-reactive lighting on desktop. The ball and controls must remain responsive during effects. Reduced-motion mode disables sweep, trail and pulsing, not gameplay or feedback. Cap DPR and particle count; target smooth play on midrange mobile. Every active state—menu, solo rally, local rally, link lobby, disconnected, winner—gets a finished layout, not raw debug text.

## Technical architecture

Use a new TypeScript/Vite application. A small DOM UI manages navigation, lobby, settings and accessible controls; Canvas 2D draws the game field at a fixed internal coordinate system and scales to the screen with DPR cap. Keep the physics pure and independent of DOM/network/rendering. A shared `core` package/module defines typed inputs, match state, deterministic fixed-step (60 Hz) simulation, swept collision handling (including fast ball vs paddle/walls), scoring and seeded CPU policies. This avoids both missed collisions and client-specific rule differences. Rendering interpolates state; `requestAnimationFrame` drives offline accumulation and never uses variable-delta physics. Keep input and simulation deterministic enough for replayable unit tests.

For LINK mode, use a minimal Node 22+ HTTP/WebSocket server, with the same simulation authoritative at 60 Hz, input validation/rate limiting, 20 Hz snapshots, bounded rooms, 6-character unambiguous codes, cryptographic reconnect tokens and 60-second reclaim. Server serves the built static client and `/healthz`. Clients send intended paddle movement and serve only; they cannot send score, position or winner. Room expiration, full room, mismatch and disconnect have explicit UI. No account, database, personal data, analytics, payment or external realtime service. Protocol must be versioned. Do not copy the old app; this is a new product and codebase.

Separate `client/`, `shared/`, `server/`, `deploy/` and `scripts/` (or an equally clear structure). No secret in the bundle. Production container: non-root where feasible, read-only filesystem, dropped capabilities, no published port, health check, isolated unique name/network alias on the existing external `girl-xtr_girl_edge` Docker network. Its Caddy target will be switched from the old app only after the new image is built, started and checked. Do not modify the shared edge or stop the old container during implementation; deployment is a separate reviewed step.

## Acceptance and release gates

1. Typecheck, build and meaningful tests for collision at high velocity, wall/paddle edge cases, serve/score/sudden death, AI levels, pause, room code, rate limits and reconnect. No dead buttons or placeholder links.
2. Independent browser checks of actual solo point and rematch, two-sided local controls, two browser clients in a LINK room through a real WebSocket and a scored point, mobile touch operation, menu/settings, refresh/reconnect and clean console.
3. Save real screenshots of the four target viewports and at least attract, active match and online lobby. Compare the finished silhouette and CRT/palette with the supplied reference while ensuring it is clearly original and more cyberpunk. Iterate on visual defects, overflow and touch ergonomics.
4. Maintain an exact deployment/rollback recipe. Before public switch: record old Caddy fragment bytes/hash, old container image/health and baseline public response; build and health-check the new container under a **new alias**. Validate the full shared Caddy config, swap only the `padel.xtr.sh` upstream, restart only Caddy, verify HTTPS/WS and unrelated sibling health. Retain the old image/container until post-release confidence. A failed post-switch gate immediately restores the exact old fragment and route.
5. Check remote branches. If `develop` exists, integrate and push final code there without force; if absent, use canonical `main` and report it. The existing `Kurubik/padel` repository is strictly read-only.

## Non-goals for v1

This is not FIP padel, 3D court simulation, public matchmaking, account system, persistent global leaderboard or a chat product. The reference image is visual inspiration only; do not reuse it as an in-app asset. Priority is a complete, polished, highly replayable arcade experience on the existing domain.
