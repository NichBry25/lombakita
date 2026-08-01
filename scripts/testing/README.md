# Full-stack testing pipeline — runner scripts

Companion to `docs/project/testing/PIPELINE.md`. These scripts are the Phase A (automated) half:
they drive the running app, assert behavior, and capture screenshots into `test-artifacts/`
(gitignored).

## Prerequisites

1. Docker services up (postgres 5432, redis 6379, meilisearch 7700).
2. `npm run dev` and `npm run worker:start` running.
3. The matrix seeded: `node --import tsx scripts/seed-test-matrix.ts`
4. **For the two browser scripts only** (`flows.mjs`, `gallery.mjs`): `npm i -D playwright`.
   Do **not** run `npx playwright install` on macOS 13 — Playwright 1.62 refuses to install
   Chromium on `mac13-arm64`. `lib-browser.mjs` points at the Chrome for Testing build already
   in `~/Library/Caches/ms-playwright/`; override with `CHROME_PATH=/path/to/binary` if yours
   lives elsewhere.

## Running

```bash
node --import tsx scripts/seed-test-matrix.ts   # always first — also resets scratch state
node scripts/testing/api-matrix.mjs             # 59 API, guard, and isolation assertions
node scripts/testing/r2-flows.mjs               # 22 real-byte upload/validation assertions
node scripts/testing/flows.mjs                  # UI flows + a screenshot of every reaction
node scripts/testing/gallery.mjs                # every page × light/dark × desktop/mobile
node scripts/testing/mobile-audit.mjs           # every page at 390px: overflow, edge, touch targets
node scripts/testing/contrast-audit.mjs         # every page x light/dark: WCAG AA text contrast
```

`contrast-audit.mjs` measures every visible run of text against the background actually painted
behind it — compositing translucent layers, and treating a single-colour gradient (the lime marker)
as the solid fill it is. It reports under 4.5:1, or under 3:1 for large text. Same regex argument
and same chunking as the gallery. Two things it deliberately skips: text inside a disabled control
(WCAG 1.4.3 exempts inactive components, and without this the disabled-CTA pattern reports on most
of the app) and skeletons. A `~` marks a finding measured under a gradient or image, where the
number is the nearest solid colour rather than what is really behind the glyphs — verify those by
eye. It catches the one class of defect nothing else here can: a token that is correct in light
mode and renders dark-on-dark in the other theme, with lint, typecheck, tests and build all green.

`mobile-audit.mjs` reports only what is measurable — a page that scrolls sideways, an element
painting past the viewport edge, a control under 44×44px. Taste still needs eyes. It takes the same
regex argument as the gallery and needs the same chunking (`for c in "^0" … "^8"`), and a flagged
page should always be **re-run on its own** before you believe it: a heavy form measured
mid-layout reports phantom undersized inputs, and a cold dev compile can time a page out outright.

`gallery.mjs` is resumable — it skips pages whose four PNGs already exist, recycles the browser
every 12 pages, and retries a page once before recording a capture error. `FORCE=1` recaptures
everything; a first argument is a regex over page ids (`node gallery.mjs "^5"`).

**Run it in chunks.** Recycling the browser is not enough on this machine: the *node* process
itself dies around the 40-page mark, silently, mid-run. Because the script is resumable, driving
it as a series of fresh processes is the fix, and the whole loop is safe to repeat:

```bash
for c in "^0" "^1" "^2" "^3" "^4" "^5" "^6" "^7" "^8"; do node scripts/testing/gallery.mjs "$c"; done
node scripts/testing/gallery.mjs   # final pass — picks up anything still missing
```

`api-matrix.mjs` deliberately runs its rate-limit assertion **last**, because it burns the per-IP
`/identify` budget for the following 60 seconds. That also means **back-to-back runs need a ~70 s
gap** — start a second run immediately and the three `/identify` classification assertions fail
with `rate_limited`, which looks like a regression and is not one.

**Reseed before every api-matrix run.** Its mutating checks restore what they touch
(publish→unpublish, feature→clear, suspend→reinstate, revoke→re-verify, invite→accept→remove,
result publish→unpublish→relabel), so the suite re-runs cleanly. Exactly one check is one-way and
depends on the seed reset to undo it:

- `PART-04` — the participation decision CASes on `participation_confirmed_at IS NULL`; there is no
  API path back, by design. Without a reseed it fails with an explanatory note, not a silent pass.

Nothing else should fail on a second run. `INV-02/03/04` used to, and that was a real defect rather
than a harness limitation: `removeMember` soft-sets `status='revoked'`, and the acceptance guard
matched membership rows without filtering on status, so a removed member could be re-invited (the
creation guard *does* filter on `active`) and could then never accept. Fixed 2026-08-01 — acceptance
now reactivates the retained row. If that block starts failing on a rerun again, suspect a
regression there before suspecting the harness.

The seed clears what the automation writes — the finalized submission, non-seed document requests,
and the notifications those actions emit. Without that last one the unread-count assertion drifts
upward by one per run.

## Files

| File | Role |
|---|---|
| `seeds.mjs` | Ids, slugs, and emails of every seeded fixture — the single place to update if the seed changes |
| `lib-auth.mjs` | Mints real NextAuth credential sessions over HTTP; thin fetch wrapper |
| `lib-browser.mjs` | Playwright launch, session-carrying contexts, theme switching, screenshots |
| `pages.mjs` | The 85-entry page inventory for the gallery (`as` selects the session) |
| `api-matrix.mjs` | Auth branches, ownership/IDOR, publish gates, ops guards, rate limiting |
| `r2-flows.mjs` | Presign → real PUT → record/finalize → read back, plus the negative cases |
| `flows.mjs` | Clicks and typing, capturing how each state looks |
| `gallery.mjs` | The design gallery |

All seeded accounts use the password `UjiCoba123!` and `@seed.lombakita.local` addresses, which
deliberately do not resolve — no seeded flow can send mail to a real person.
