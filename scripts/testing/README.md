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
node scripts/testing/api-matrix.mjs             # 100 API, guard, and isolation assertions
node scripts/testing/r2-flows.mjs               # 22 real-byte upload/validation assertions
node scripts/testing/flows.mjs                  # UI flows + a screenshot of every reaction
node scripts/testing/gallery.mjs                # every page × light/dark × desktop/mobile
node scripts/testing/mobile-audit.mjs           # every page at 360/375/390px: overflow, edge, targets
node scripts/testing/contrast-audit.mjs         # every page x light/dark: WCAG AA text contrast
node scripts/testing/ui-states.mjs              # what each surface must SAY and must NOT OFFER
```

All three now run in CI on every PR (`.github/workflows/ci.yml`, job `browser audits`), against a
production build of the branch and a freshly seeded matrix. Running them locally is still the way to
see a failure quickly; it is no longer the only way they run.

**Running is not gating.** A job blocks a merge only while branch protection lists its display name
in `required_status_checks.contexts`. That list holds `lint, typecheck, test` and nothing else, so
the browser audits currently report their findings without being able to fail a pull request on
them. Making them block is a repository setting; until it is made, a red audit here is a signal to
read, not a wall.

## Exit codes, shared by `contrast-audit` and `mobile-audit`

| Code | Meaning |
|---|---|
| 0 | measured; nothing outside the baseline |
| 1 | measured; findings this baseline does not carry |
| 3 | REFUSED to measure — the stylesheet preflight |
| 4 | at least one page could not be measured |
| 5 | a finding — emitted, carried forward, or already in the baseline — that nothing can compare |

**3, 4 and 5 are refusals, not findings.** Exit 3 means the browser was not loading the stylesheet on
disk, so nothing measured would have been about the working tree: the audit prints why and produces
no report. Exit 4 means a page timed out or errored; that page is not a lower total, it is a run
that cannot describe the app, and it can never be baselined away. Exit 5 means an audit emitted a
finding whose class is absent from `finding-classes.mjs`, or whose magnitude did not compute to a
finite number: the comparison has no idea whether that finding got worse, so the run refuses rather
than report a total it cannot stand behind.

**Exit 5 covers the RECORDED side too, and that is where it was missing.** The emit gate stopped an
undeclared finding being written; nothing stopped one that was already in the file. Twelve entries
across the two baselines carried no magnitude — all six contrast findings, which predate
`finding()`, and six `seenIn: ci` entries copied forward by every regeneration since. The comparison
stepped over each of them, so they were held to their KEY alone: the exact behaviour the magnitude
table was added to end, live under a green run. Every tone pairing could have decayed from 9.92 to
0.5, and three pages from 400px of overflow to 900px, without the gate saying a word. A recorded
entry nothing can compare is now refused at three points — when the comparison reads it, when a
regeneration would carry it forward, and when the run would otherwise print its verdict.

## Finding classes

`finding-classes.mjs` is the declaration of what these audits can find. Every class names the audit
that emits it, what it describes, the unit it is measured in, and a `magnitudeOf` that turns a
measurement into a single number where **higher is always worse**. Two of the five measure something
where lower is worse in the real world — a contrast ratio, a tone separation — so they store the
DEFICIT against their threshold, which restores the direction.

`finding-classes.test.ts` scans both audit files for `finding("<class>", …)` and asserts the declared
set equals the emitted set in both directions. Adding a finding class to an audit without declaring
it here is a failing test, and, if it somehow ships, a runtime exit 5.

## Baselines

`scripts/testing/baselines/*.json` records the findings that were present when the baseline was
taken. A run fails on findings NOT in its baseline and reports (without failing) the baselined ones
that no longer reproduce, so the file gets pruned rather than trusted forever.

**A baselined finding still fails when it gets worse.** Each entry carries its magnitude, and a
measured finding whose magnitude exceeds the recorded one is reported as WORSENED and exits 1 even
though its key is allowlisted. Being known is permission to stay as bad as you were, not permission
to decay: the allowlist absorbs the finding, never a later regression at the same key.

Re-take a baseline deliberately, never as a reaction to a red run:

```bash
UPDATE_BASELINE=1 node scripts/testing/contrast-audit.mjs
UPDATE_BASELINE=1 node scripts/testing/mobile-audit.mjs
```

### `UPDATE_BASELINE=1` cannot silently drop what your machine cannot see

A baseline entry marked `seenIn` was measured somewhere this run is not — the CI runner, a different
platform, a viewport nobody reproduces locally. Your machine not reproducing it is not evidence it
is fixed; it is evidence you are not the machine that saw it. So `UPDATE_BASELINE=1` **carries every
`seenIn` entry forward** and prints one `KEPT` line per entry, rather than writing a file that quietly
declares those findings resolved.

To actually drop them, say so:

```bash
DROP_CURATED_FINDINGS=1 UPDATE_BASELINE=1 node scripts/testing/mobile-audit.mjs
```

The second flag exists so that dropping a finding measured elsewhere is a sentence somebody typed,
not a side effect of re-taking a baseline on a laptop.

**A carried entry still has to be comparable.** Carry-over is the one path into a baseline that
never passes the emit gate, which is how six entries with no magnitude survived every regeneration
and could never acquire one. A regeneration now refuses (exit 5, `UNCARRIABLE`) rather than copying
such an entry into the new file. Give it the class its key names and the magnitude the machine that
recorded it measured — and where that machine is CI, the number has to come from a CI run, not from
a guess made here. Dropping stays open, because dropping deletes the entry rather than keeping it in
a state nothing can compare.

## Proving the guards

```bash
npm run verify:contrast-selftest   # audits the contrast auditor against hand-computed pairings
npm run verify:guard-probes        # Rule 36 probes for the config gates — no server needed
BASE_URL=http://localhost:3100 npm run verify:audit-probes   # Rule 36 probes for the refusals
```

`verify:audit-probes` wants a PRODUCTION build (`npm run build && npx next start -p 3100`), because
it edits a stylesheet on disk and asks whether the audit notices: against `next dev` that edit races
a recompile, and the probe would be measuring the dev server rather than the guard. Both probe
suites mutate committed files and restore them from git per file, asserting `git diff --quiet`
afterwards; they refuse to start if anything they touch differs from HEAD.

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
painting past the viewport edge, a control under 44×44px. Taste still needs eyes.

**It walks the inventory once per width in `MOBILE_VIEWPORTS`, which is 360, 375 and 390.** For most
of its life it measured 390 alone, and 390 is the widest of the three and the only one where the
institution-public pages read clean: they lay out 384px of content, which fits inside 390 with six
pixels to spare and hangs 24px off a 360px screen. A run reporting "104/105 pages clean" was
describing one forgiving width. Every finding key now carries the width it was taken at
(`<page>|<width>|<class>`), the summary prints a clean count per width, and `mobile-viewports.test.ts`
holds the declaration to the baseline in both directions: a width cannot leave the set while the
baseline carries readings taken at it, and it cannot join the set without the baseline being
re-taken. Three navigations per page is what this costs; a page is loaded fresh at each width rather
than resized, because a component that measures itself on mount keeps the width it mounted at. It takes the same
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
| `lib-browser.mjs` | Playwright launch, session-carrying contexts, theme switching, screenshots, and `MOBILE_VIEWPORTS` — the widths the mobile audit measures |
| `pages.mjs` | The 85-entry page inventory for the gallery (`as` selects the session) |
| `api-matrix.mjs` | Auth branches, ownership/IDOR, publish gates, ops guards, rate limiting |
| `r2-flows.mjs` | Presign → real PUT → record/finalize → read back, plus the negative cases |
| `flows.mjs` | Clicks and typing, capturing how each state looks |
| `gallery.mjs` | The design gallery |
| `finding-classes.mjs` | What the audits can find, and how bad each finding is — pinned to the audits by test |
| `lib-audit-baseline.mjs` | Baseline read/compare/write, the worsening check, and the exit-code contract |
| `lib-assertions.mjs` | The response-assertion vocabulary both API harnesses share |
| `assertion-harnesses.ts` | Which files the assertion-strength gate reads — pinned to disk by test |
| `assertion-strength.ts` | Rejects an assertion that cannot fail, resolving helpers through the TypeChecker |
| `guard-probe.mjs` | The Rule 36 probe runner: compile, apply, assert, restore from git |
| `mobile-viewports.test.ts` | The declared mobile widths, pinned against the widths the baseline was taken at |
| `declared-assertions.mjs` | What `r2-flows` says it asserts, and the denominator its summary divides by — pinned to the harness by test |
| `assertion-resolution.test.ts` | The strength gate's resolution, across every spelling an import takes |
| `fixtures/` | Helper modules in each import spelling, for the resolution test |
| `probes/detectors.mjs` | Shared refusal detectors — a probe is red only for the reason it names |

All seeded accounts use the password `UjiCoba123!` and `@seed.lombakita.local` addresses, which
deliberately do not resolve — no seeded flow can send mail to a real person.
