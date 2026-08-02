# Live R2 retention and orphan-sweep verification

`r2-retention.ts` proves that the retention purges and the orphan sweeps actually delete bytes from
R2, and that they leave behind exactly what they are supposed to leave behind.

The unit suite cannot prove this. It mocks `listObjects` and `deleteObject`, so the tests assert the
*shape* of the call and nothing about the outcome. A purge that lists the wrong prefix, deletes
nothing, or deletes the finalized entry it exists to protect passes that suite. The only assertion
that settles it is reading the bucket back afterwards.

Closes **DOCVERIF-T4**, **SUBMISSION-T1**, and **RECRUITER-DOC-T1**.

## Running it

Local Postgres up (`DATABASE_URL`) and R2 credentials in `.env.local` (`R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). Railway is not required.

```bash
node --import tsx scripts/retention/r2-retention.ts
```

The script refuses to run if `isR2Available()` is false rather than skipping — a skipped check that
prints nothing is how this gap stayed open. It seeds its own competitions and accounts, uploads real
bytes through the real presigned PUT path, and cleans up both the rows and the objects afterwards.

Exit code 0 when all 24 checks hold, 1 otherwise.

## What each part proves

| Part | The claim a row-driven implementation would get wrong |
|---|---|
| `DOC-R*` | The document purge deletes **by storage prefix**, so an object PUT and never finalized goes with the rest. The request row **survives** its files — verdict, reviewer, timestamps intact (DEC-0122). |
| `SUB-R*` | A **finalized** submission is never purged at any age. The keep-set is built from finalized rows and everything else under the prefix is deleted (DEC-0126). |
| `REC-R*` | The orphan sweep is **age-guarded**, so an upload still inside its presign window is not deleted out from under a user mid-upload (DEC-0111). |

Each part also pins the negative cases the scheduler depends on: a competition inside its grace
window is not due, and a competition with no `event_end_at` is **skipped, never purged**.

## Guard-removal probes

Run 2026-08-02. A test that still passes with the guard removed is not a test, so each guard was
deleted, the script re-run, and the guard restored from a byte-identical diff check.

| Guard removed | Result |
|---|---|
| The finalized keep-set in `purgeUnfinalizedSubmissionsForCompetition` | `SUB-R06` fails: the bucket ends **empty**. The participant's entry is destroyed while its database row survives, so the row points at bytes that no longer exist — the silent version of the bug. |
| Prefix-driven deletion in `purgeDocumentsForCompetition`, replaced with a row-driven walk | `DOC-R05`/`R07`/`R08` fail: a student's identity document stays in the bucket forever, and because the file rows *are* deleted, nothing in the database remembers it exists. Exactly the liability DEC-0122 exists to bound. |
| `options.respectAge` in `sweepOrphanedSubmissionObjects` | `REC-R01` fails: a fresh upload is deleted while its presign window is still open. |

## Note on the R2 bucket

The script writes to whatever bucket `.env.local` points at, under `registration-documents/`,
`submissions/`, and `recruiter-verification/` prefixes keyed by freshly-generated UUIDs, so it
cannot collide with real data. Cleanup is best-effort on the objects the purges under test did not
already remove; a crashed run may leave a handful of small PDFs behind under those UUID prefixes.
