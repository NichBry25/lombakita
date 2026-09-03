# Lombakita

[![CI](https://github.com/NichBry25/lombakita/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NichBry25/lombakita/actions/workflows/ci.yml)
[![Nightly verification](https://github.com/NichBry25/lombakita/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/NichBry25/lombakita/actions/workflows/verify.yml)

Indonesia-first student opportunities platform (competitions-first MVP). Next.js 16 + TypeScript,
PostgreSQL + Drizzle ORM, Auth.js, Meilisearch, Redis + BullMQ, Cloudflare R2, Resend, Sentry.

The nightly badge reports the concurrency race scripts and the contrast auditor self-test, which the
unit suite structurally cannot check. It is here because fourteen nightly-failure notifications were
delivered in two weeks and thirteen were never opened: a badge is read where a notification is not.
Its state is also reported by `/close-step`, so a red night is seen at the moment a work unit closes.

Project instructions and the durable truth files live in [`CLAUDE.md`](CLAUDE.md) and
[`docs/`](docs/).

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run db:migrate:guarded   # apply migrations (always use the guarded script)
npm run dev
```

Useful scripts: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`,
`npm run env:check`, `npm run connectors:status`.

## Cloudflare R2 (file storage)

R2 backs competition **submission uploads** (activated at Step 4.6). Files are uploaded directly
from the browser to R2 via short-lived presigned PUT URLs; the app stores only file metadata.

Required environment variables (see [`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` — encodes the Cloudflare account id |
| `R2_BUCKET` | Bucket name |
| `R2_ACCESS_KEY_ID` | R2 access key id |
| `R2_SECRET_ACCESS_KEY` | R2 secret access key |
| `R2_REGION` | Optional; defaults to `auto` |

**Graceful degradation.** The submission upload-URL endpoint
(`POST /api/v1/competitions/[competitionId]/registrations/[registrationId]/submission/upload-url`)
checks `isR2Available()` before signing. When any of the four credentials above is missing it
returns **HTTP 503 `submission_upload_unavailable`** (never an uncaught 500), so the app remains
usable without R2 configured — only the upload step is unavailable. This mirrors the Meilisearch
degradation model (`isMeilisearchAvailable()`).

> Security note (MVP boundary): submission file keys are server-generated as
> `submissions/{registrationId}/{uuid}` and the metadata-record endpoint validates the key prefix
> before any DB write. The app does **not** verify the object actually exists in R2 — key-prefix
> validation is the MVP security boundary. Presigned download (GET) is deferred to a later step.
