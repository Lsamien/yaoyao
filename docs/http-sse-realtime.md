# HTTP + SSE realtime bridge

15300 remains the only client entrypoint. It owns authenticated upstream WebSocket connections to 9119; it does not run a second Agent engine or move Python group data.

## Contract (version 1)

All endpoints are relative to `/api/realtime` (also supported beneath an authorized `/node/:deviceID` base URL).

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/capabilities` | `protocolVersion`, `channels`, `brokerEpoch`; Cookie callers also receive a CSRF token. |
| POST | `/channels` | `{channel:"chat"}` or `{channel:"groups",epoch,cursor}`; returns `{id,brokerEpoch}`. |
| GET | `/channels/:id/events` | SSE `ready`, `frame`, `reset`; `frame.data` is the existing RPC/group envelope. |
| POST | `/channels/:id/commands` | Whitelisted RPC `{method,params}` plus a stable `Idempotency-Key`. |
| GET | `/commands/:requestId` | Auth-scoped command receipt. |
| DELETE | `/channels/:id` | Detach the subscriber; does not stop a running Agent. |

Cookie mutations require Origin and X-CSRF-Token. Paired Bearer callers retain their device scopes. SSE credentials are headers/Cookies, never long-lived query credentials. Each channel belongs to its authenticated principal; opening a session explicitly registers that route. Existing shared-history access is unchanged, but events are not broadcast to unrelated subscribers.

Chat frames retain their upstream seq separately from the opaque SSE `id`. Send `Last-Event-ID` only to the same channel. `409 reset_required`, SSE `reset`, or a missing channel requires session resume and authoritative REST history reconciliation. A mere downstream network interruption reconnects the same channel without rebuilding runtimes. Group envelopes retain their original epoch/cursor validation.

## Receipts and failure semantics

`state` is `confirmed`, `rejected`, `pending`, or `unknown`. Only an actual upstream RPC acknowledgement is confirmed; receiving HTTP 200 alone is not a submission acknowledgement. Identical keys reuse the original operation; different payloads under one key conflict. Network retry must retain the key and original encoded command, not rerun attachment preparation. The iOS Outbox ID is the prompt key.

`realtime-receipts.sqlite3` records write-ahead fingerprints and bounded recovery metadata, not prompts, attachment bytes, transcript content or full event streams. Allowed attachment commands retain their file references; allowed configuration commands retain their applied value and model confirmation metadata. Terminal results retain 24 hours, then compact into permanent owner/request/fingerprint tombstones that return `unknown`. Compaction never makes an admitted request executable again, including after a restart; changed payloads still conflict. Tombstones contain no command bodies or RPC results and grow with unique retired admissions. Pending operations become unknown on process restart. Unknown receipts are never automatically re-executed or evicted to permit retries; capacity exhaustion rejects new admissions. Full RPC results have a separate bounded in-memory cache, so clients must refresh resource data rather than assume a history snapshot was persisted.

Clients must persist each stable command ID as attempted **before** its POST. An absent receipt is permission to submit only when a durable local record proves that command was never attempted. For an attempted or legacy uncertain prompt, reconcile the exact `client_message_id` against the canonical transcript; absence from a recent page is not proof of non-execution. Keep unresolved sends uncertain, and never submit an attachment label without a recovered file reference.

## Resource limits and HTTP-only clients

- Recent events: 10 minutes, 8 MiB or 10,000 events per principal, 128 MiB globally.
- At most 8 live subscribers per principal. Up to 32 detached/reconnectable handles; oldest detached handles may be evicted under pressure and then require REST recovery.
- Slow output: 1 MiB backlog / 15 seconds; detach only the slow downstream.
- Idle upstreams close after five minutes with no channels, work or pending commands. Running/waiting Agent sessions are retained.
- Dedicated RPC parser retains 36 MiB frame / 25 MiB attachment bounds. The global JSON parser remains 2 MiB.
- Old client WS endpoints, WS tickets and realtime leases are removed. Requests receive `410 http_sse_required`; only server-to-9119 WebSockets remain. HTTP RPC mutations use CSRF or paired Bearer authorization.
- Ordinary chat push recovery uses broker transports. Group push retains its independent durable journal cursor.
- Different credential scopes are not silently pooled. If they target the same already-owned runtime, the bridge fails closed with `session_scope_conflict` instead of stealing its upstream event receiver.

This does not guarantee Agent survival after 15300/9119 restarts or prolonged upstream loss. Upstream recovery uses `session.events.since` when available; missing/truncated replay falls back to REST history, not to an old client transport. Web and shipping iOS clients require HTTP+SSE capability version 1. Missing capabilities, authentication errors and network errors never downgrade to WebSocket.

## Verification

Run `npm run typecheck`, `npm test`, `npm run build`, and `npx playwright test`. Realtime tests cover shared ownership, route isolation, CSRF, durable unknown receipts, reply loss, replay, cache pressure and a real 21-second downstream outage. Fixture latency samples are not model inference benchmarks.

The iOS `HTTPRealtimeAcceptanceUITests` is opt-in (`HERMES_SSE_ACCEPTANCE=1` in the test runner environment). Start the isolated 19119 fake Hermes and 18801 e2e server and initialize the fixture admin password as in Playwright before running it. It uses an ephemeral cookie jar, not saved user accounts.
