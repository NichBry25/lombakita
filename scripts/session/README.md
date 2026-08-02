# Live session-gate verification

`live-session-gates.ts` proves that a session **already in flight** is re-evaluated against the
database on every request, not against the JWT it was minted with.

The session strategy is permanently JWT — a Credentials provider forbids database sessions in
Auth.js, see the restated `auth-D3` — and the cookie lives for a year. Everything that makes an
admin demotion or a suspension take effect *now* rather than in twelve months is
`loadLiveAccountState` reading `users.role` and `users.suspended_at` on each request. The unit
suite covers that function and the guard above it separately; nothing had ever held a real cookie,
changed the row underneath it, and asked the running app what happens next.

Closes **H3-T1**, **RG-T1**, and **RG-T2**.

## Running it

Dev server on `BASE` (`npm run dev`), local Postgres, and the seeded users.

```bash
node --import tsx scripts/session/live-session-gates.ts
```

Exit code 0 when all 14 checks hold, 1 otherwise.

The script mutates `users.role` and `users.suspended_at` on two seed accounts, restores them in a
`finally`, and then **re-reads both rows to confirm the restore landed**. A seed left demoted or
suspended would quietly break every later run of the other suites, so that last pair of checks is
not ceremony.

## Why a browser and not `fetch`

Both reasons were learned by getting it wrong first, and they are recorded because the next person
writing a page-guard test will reach for `fetch`:

1. **A `redirect()` from a Server Component does not reliably surface as a 307.** Next answers
   `200` and resolves the navigation from the payload. A status-code assertion therefore reports a
   *working* guard as a failure — and, far worse, would report a *removed* guard as a pass, because
   a rendered page is also `200`. The honest assertion is where the browser ends up and which
   heading rendered.
2. **Participant nav visibility is decided client-side** from `session.user.role` (`RG-D4`), so it
   is simply absent from server HTML. A fetch-based check of the markup measures nothing.

## Guard-removal probes

Run 2026-08-02. Both reverted afterwards with `src/` verified byte-identical against HEAD.

| Guard removed | Result |
|---|---|
| `loadLiveAccountState` forced to `unavailable` | `RG2-02`/`RG2-03` fail — **a suspended account keeps browsing the dashboard**. The operational checks also fail, but by bouncing to `/auth/login`: `unavailable` fails *closed* for operational roles, which is the DEC-0112 split working as designed. |
| The live role ignored, JWT role trusted (suspension read left intact) | **`H3-02` alone fails** — the demoted admin keeps full `/admin/institutions` access on the same cookie, while suspension still works. A clean isolation of the role half of the guarantee. |

## Known gap pinned here

`RG1-05` asserts a **current** behaviour rather than a desired one. The site footer is
session-independent and links every visitor to `/candidate-dashboard`, so an operational account is
offered a link that bounces straight back to `/admin`. The header nav correctly withholds it
(`RG1-03`). Filed as `RG-D8`; when the footer is fixed, flip that check to `=== 0` and fold it into
`RG1-03`.
