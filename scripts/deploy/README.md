# Deploy environment gate

Three checks that run in `.github/workflows/deploy.yml`, on every PR (preview) and every promotion
to production. Together they answer: **is this environment correctly configured, can those
credentials actually reach each service, and does the deployed app work?**

They exist because of a specific failure. Every fault in the 2026-08-03 R2/Google-OAuth session was
**a value that was present, non-empty, and wrong** — `R2_ENDPOINT` holding the whole
`R2_ENDPOINT=https://…` line pasted into Vercel's value field, a literal `<account-id>` on Railway,
`replace-me` credentials. `isR2Available()` is a presence check, so it returned true, the app
reported storage as available, and every upload threw 500 instead of degrading to the designed 503.
`npm run env:check` could not have caught any of it either: `getRuntimeEnvValidation` records a key
as missing only when it is **falsy**.

Closes **OBS-D1** and **OBS-D3**, and the probe half of **INCIDENT-2026-07-16**.

## The three layers

Each catches something the others structurally cannot. That separation is the whole design — do
not collapse them.

| Layer | Command | Runs | Catches |
|---|---|---|---|
| 1. Shape | `npm run verify:deploy-env` | runner, after `vercel pull`, before `vercel build` | present-but-wrong values. No network. |
| 2. Live connectors | `npm run connectors:status:live` | same spot, same pulled env | credentials that do not reach the service |
| 3. Smoke | `node scripts/deploy/smoke.mjs <url>` | after deploy | anything only the deployed runtime shows |

Layers 1 and 2 **prevent** a bad config — they run before anything is built, so production keeps
serving the previous deployment. Layer 3 **detects** a bad deploy: nothing can test a deployment
that does not exist yet. A red smoke means roll back with
`gh workflow run deploy.yml --ref <last-good-sha>`.

On production the smoke runs **last**, after the Railway worker step, so web and worker promote in
lockstep and the check sees the whole promoted system rather than half of one.

## Running them by hand

Against whatever is in `.env.local`:

```bash
npm run verify:deploy-env -- --environment=production
npm run connectors:status:live
node scripts/deploy/smoke.mjs https://lombakita.com
```

Against a real deployed environment, without touching your local `.vercel/`:

```bash
vercel env pull --environment=preview /tmp/.env.preview
npm run verify:deploy-env -- --environment=preview --env-path=/tmp/.env.preview --require-env-file
npm run connectors:status:live -- --environment=preview --env-path=/tmp/.env.preview --require-env-file
rm /tmp/.env.preview   # it holds live credentials
```

`--require-env-file` is the anti-silent-no-op guard: without it, a Vercel CLI change that moves the
pulled file would leave the checks running against an empty environment and reporting whatever that
produces.

## Extending it

**Adding a connector or a required environment variable means editing two places**, or the gate
silently covers less than it appears to:

1. `src/config/env-shape.ts` — add a `DEPLOY_ENV_KEY_SPECS` entry with `requiredIn` and, where the
   value has a recognisable form, a `rule`. The `inspects every key…` test in `env-shape.test.ts`
   pins the full list, so a forgotten entry fails there rather than quietly narrowing the gate.
2. `src/server/connectors/status.ts` — add a `runConnectorProbe` call, with an
   `is<X>Configured()` / `probe<X>()` pair next to the client it probes.

**A probe must be able to fail on the most likely misconfiguration.** `probeMeilisearch` originally
called the unauthenticated `/health`, which answers `available` to anyone who can reach the host
whatever key they supply — so it reported ok throughout the weeks the preview key was dead. It now
runs the same query the public listing runs. A probe that cannot fail is worse than no probe,
because it reports success.

## Things that will bite you again

- **`--env-file` is a reserved Node CLI flag.** Node parses it even when it appears after the
  script path and exits before the script runs. The flag here is `--env-path`.
- **Vercel Deployment Protection does not answer 401.** It answers 302 to `vercel.com/sso-api`, and
  `fetch` follows that to a **200** HTML login page. The smoke detects it by where the redirect
  chain ended, and asserts the homepage body carries the app's own marker — a 200 alone proves
  nothing. Preview needs `VERCEL_AUTOMATION_BYPASS_SECRET` set in **both** Vercel (Deployment
  Protection → Protection Bypass for Automation) and the GitHub repo secrets; nothing enforces that
  the two match.
- **Do not send `x-vercel-set-bypass-cookie`.** It asks Vercel to set a cookie for later browser
  requests, which a one-shot script has no use for, and it broke the request outright as a bare
  `TypeError: fetch failed`.
- **Preview genuinely has no `APP_BASE_URL`** (Vercel injects it per deployment from `VERCEL_URL`),
  and `assertRuntimeEnv("web")` runs at module load in the probe import chain. Layer 2 therefore
  gets a placeholder base URL on preview, for the same reason `vercel build` already does. Layer 1
  deliberately does **not** — it must see the real, absent value rather than a placeholder that
  would satisfy its https rule.
- **`connectors-status.ts` imports `@/server/connectors/status` dynamically.** `serverEnv` snapshots
  `process.env` at module load (`env.server.ts:153`), so a static import would bind the environment
  as it stood *before* the pulled file was read, and every probe would run against the wrong values.

## Deliberately not in the gate

Worker liveness (`npm run connectors:status:worker`) enqueues a real job and waits up to 20s for a
worker to consume it. The production gate runs in the same job that is about to redeploy the
worker, so a redeploy in flight would fail a check measuring the outgoing process. It is wired into
`getConnectorStatusPayload` and available on demand.
