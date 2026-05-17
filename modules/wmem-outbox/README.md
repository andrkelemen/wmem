# wmem-outbox

Local proxy daemon. Sits between a MCP client/scripts and upstream canonical wmem.
Buffers writes to a local SQLite outbox when upstream is unreachable; drains on reconnect.

**Reference:** wmem multi-instance PR-D. **Spec:** `docs/outbox-spec.md (in this repo)`.

## What it does

```
MCP client / scripts
       ↓ POST localhost:4201/<path>
[wmem-outbox daemon]
       ↓ forward
upstream :4200/<path>
```

- **Upstream reachable + 2xx/3xx/4xx**: passes response back verbatim
- **Upstream unreachable / 5xx (writes only)**: buffers in outbox.db, returns `202 Accepted` with `X-Wmem-Outbox: buffered`
- **Drain loop** replays buffered rows to upstream when reachable, with exponential backoff
- **Dedup-aware**: upstream's `{deduped:true}` or `409` collapses to DELETE (no infinite re-replay)

## Install (Linux)

```bash
bash modules/wmem-outbox/install/install.sh
```

Installs systemd-user service. Starts immediately. Survives reboot via `enable`.

## Quick check

```bash
curl -s http://127.0.0.1:4201/health | jq
```

## Config (env vars)

| Env | Default | Purpose |
|---|---|---|
| `WMEM_UPSTREAM_HOST` | `127.0.0.1` | upstream hostname/IP |
| `WMEM_UPSTREAM_PORT` | `4200` | upstream wmem API port |
| `WMEM_OUTBOX_PORT` | `4201` | local daemon listen port |
| `WMEM_OUTBOX_BIND` | `127.0.0.1` | listen interface |
| `WMEM_OUTBOX_DB` | `~/.local/share/wmem/outbox.db` | sqlite path |
| `WMEM_OUTBOX_TICK_S` | `5` | drain interval (sec) |
| `WMEM_OUTBOX_BATCH` | `25` | rows per drain |
| `WMEM_OUTBOX_DEAD_LETTER_AFTER` | `12` | retries before dead-letter |
| `WMEM_OUTBOX_BACKOFF_BASE_S` | `30` | exponential backoff base |
| `WMEM_OUTBOX_TIMEOUT_MS` | `3000` | per-request timeout |
| `WMEM_OUTBOX_PROBE_S` | `10` | upstream reachability poll |
| `LOG_LEVEL` | `info` | debug/info/warn/error |

## Endpoints

### Reserved (daemon-local)

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | daemon + upstream status, outbox counts, last drain |
| `GET` | `/role` | cached upstream role (master/mirror/unknown) |
| `POST` | `/admin/drain` | force drain tick |
| `GET` | `/admin/outbox` | list pending + dead-letter rows |
| `DELETE` | `/admin/outbox/dead-letter` | manual purge dead-letters |

### Passthrough

Everything else is forwarded to upstream :4200.

## Smoke test

```bash
node modules/wmem-outbox/smoke.mjs
```

Stops upstream wmem mid-test → asserts buffer → restarts → asserts drain.
Set `SMOKE_SKIP_DESTRUCTIVE=1` to skip the stop/start steps.

## Failure modes

See spec §6 for full catalog. Key ones:
- Upstream reachable + 4xx → response passed back, **no buffer** (caller bug)
- Outbox db corrupt at startup → renamed `*.corrupt-<ts>`, fresh init (loud log)
- Dead-letter rows stay in db forever (admin endpoint to manual purge)
- upstream role flipped to non-master mid-flight → drain still runs, isMaster gate refuses with 403 → dead-letter

## Architectural fit

This daemon is the *write-side* counterpart to the local read-only wmem mirror.
Combined: replicas run a read-only mirror for fast offline reads + this daemon for
write-with-buffer. Upstream :4200 remains the single canonical writer (enforced by
the isMaster gate in upstream's server.mjs).

Per wmem multi-instance recovery sequence:
- PR-D (this) lands the daemon
- PR-E will repoint each replica's `.mcp.json` from `localhost:4200` (direct upstream) to
  `localhost:4201` (this daemon). One replica at a time, 1-day soak between.
- PR-F will set up rsync timer for the read-only mirror.
