# Deploying RETRO//PADEL

> **Status: authored, not applied.** The implementation work in this repository did **not** build,
> start, publish or route anything. Switching `padel.xtr.sh` is a separate, reviewed cutover owned by
> the reviewer. Nothing here touches the existing `Kurubik/padel` repository, its container, the
> shared Caddy config, DNS or any other service.

## 1. Build and smoke the image under a new identity

```bash
docker build -f deploy/Dockerfile -t retro-padel:<git-sha> .
docker run --rm -d --name retro-padel-canary \
  --network girl-xtr_girl_edge \
  --network-alias retro-padel-canary \
  --read-only --tmpfs /tmp:size=8m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  retro-padel:<git-sha>
```

Wait for the health check, then verify from inside the edge network before touching any route:

```bash
docker exec retro-padel-canary node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)"
```

Expected: `{"ok":true,"rooms":0,"uptime":<n>,"v":"RP1"}`.

The container publishes **no ports**; the edge reaches it by network alias only.

## 2. Baseline the current production route (before any switch)

Record, so a rollback is exact rather than approximate:

1. The active Caddy fragment **bytes and hash** for `padel.xtr.sh` (`sha256sum`).
2. The old container's **image digest, container id and health status**.
3. A **baseline public response** for `https://padel.xtr.sh` (status, `content-length`, body hash) and a
   note that the old app stays running and routable until post-release confidence.

## 3. Shared-config validation, then a single upstream swap

1. Write the candidate config and run `caddy validate --config <file>` **before** reloading.
2. Change only the `padel.xtr.sh` upstream: a `reverse_proxy` to the new network alias. WebSocket
   upgrade must pass through (Caddy's `reverse_proxy` does this transparently — do not add a separate
   `/ws` matcher that strips upgrade headers).
3. Restart **only Caddy** — never the whole edge, and never the old app container.
4. Verify HTTPS, then verify a real WebSocket session (create a room in one browser, join with the
   invite link in another, score a point).
5. Re-check unrelated sibling hostnames — they must be unaffected.

## 4. Rollback gate

A failed post-switch check immediately restores the **exact** recorded fragment bytes from step 2,
validates, restarts only Caddy, and re-verifies `https://padel.xtr.sh`. The old image and container are
retained until confidence is established.

## 5. Operational notes

- `PORT` (default `8080`), `HOST` (default `0.0.0.0`), `STATIC_DIR` (default `./dist`) and
  `MAX_ROOMS` (default `200`) are the only environment inputs. No secrets are required and none are
  read from disk.
- Rooms live in memory. A container restart ends every in-flight room; the client surfaces the closed
  socket as `LINK LOST` with a 60-second reclaim attempt and then an explicit message. Run one replica
  unless a shared room registry is added, because rooms are not replicated.
- The server binds `/healthz` for container and edge health checks and serves the built client with
  long-lived caching for `/assets/*` and `no-cache` for `index.html`.
