/**
 * Deploy gate, layer 3: does the RUNNING deployment work?
 *
 *   node scripts/deploy/smoke.mjs https://lombakita.com
 *
 * Layers 1 and 2 run on the CI runner and prove the configuration is well-formed and that those
 * credentials reach each service from there. Only this one exercises the deployed runtime, which
 * is where Vercel injects environment values and where a request actually gets served.
 *
 * Dependency-free on purpose (global fetch only) so it can run before or without `npm ci`.
 *
 * Vercel Deployment Protection: set VERCEL_AUTOMATION_BYPASS_SECRET and the bypass header is sent
 * automatically. Without it a protected deployment answers 401 to this script, which is reported
 * as a distinct, actionable failure rather than a generic bad status.
 */

const HEALTH_PATH = "/api/health";
const RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 13_000];

const baseUrl = process.argv[2]?.replace(/\/+$/, "");

if (!baseUrl) {
  console.error("usage: node scripts/deploy/smoke.mjs <baseUrl>");
  process.exit(1);
}

// Trimmed because the value is pasted through two consoles on its way here, and a stray newline
// would otherwise travel into an HTTP header.
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

// x-vercel-set-bypass-cookie is deliberately NOT sent: it asks Vercel to set a cookie so later
// browser requests bypass too, and this script makes one-shot requests that never reuse a session.
const requestHeaders = bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

const pass = (label, detail) => {
  console.log(`  PASS  ${label.padEnd(22)} ${detail ?? ""}`.trimEnd());
};

const fail = (label, detail) => {
  failures += 1;
  console.log(`  FAIL  ${label.padEnd(22)} ${detail}`);
};

// `fetch` reports every transport problem as the same opaque "TypeError: fetch failed" and puts
// the actual reason — DNS failure, TLS error, redirect loop — on `cause`. Reporting only the
// message turns four distinct faults into one indistinguishable line, which is how a diagnosis
// turns into a bisection.
const describeError = (error) => {
  const parts = [];
  let current = error;

  while (current) {
    const code = current.code ? ` (${current.code})` : "";
    parts.push(`${current.name ?? "Error"}: ${current.message ?? String(current)}${code}`);
    current = current.cause instanceof Error ? current.cause : undefined;
  }

  return parts.join(" ← ");
};

const describeProtectionBlock = () =>
  "Vercel Deployment Protection is intercepting this request. Set " +
  "VERCEL_AUTOMATION_BYPASS_SECRET (Project Settings → Deployment Protection → Protection " +
  "Bypass for Automation, then add it as a GitHub secret) or disable protection for this " +
  "environment.";

// Protection does NOT answer 401. It answers 302 to vercel.com/sso-api, and fetch follows that
// to a 200 HTML login page — so status alone reports success on a request that never reached the
// app. The reliable signal is where the redirect chain ended up: bounced onto vercel.com means
// the deployment refused us. A same-site or apex redirect (www → apex is a real 308) is
// unaffected, because only the vercel.com SSO host counts as a block.
const SSO_HOST = "vercel.com";

const isProtectionBlocked = (response) => {
  if (response.status === 401) {
    return true;
  }

  try {
    const finalHost = new URL(response.url).hostname;

    return finalHost === SSO_HOST || finalHost.endsWith(`.${SSO_HOST}`);
  } catch {
    return false;
  }
};

// A 200 is not proof the app served the page — Vercel's own interstitials are 200s too. Asserting
// on content is what makes this check mean something.
const APP_MARKER = "lombakita";

// A deployment that has only just been created can answer before it is routable, so transport
// errors and gateway statuses are retried. A response the app itself produced — including a 503
// naming the failed check — is a verdict, not a transient, and is returned immediately.
const fetchHealth = async () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${HEALTH_PATH}`, { headers: requestHeaders });

      if (response.status !== 502 && response.status !== 504) {
        return { response, body: await response.text() };
      }

      if (attempt >= RETRY_DELAYS_MS.length) {
        return { response, body: await response.text() };
      }
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        return { transportError: error };
      }
    }

    await sleep(RETRY_DELAYS_MS[attempt]);
  }
};

const checkHealth = async () => {
  const { response, body, transportError } = await fetchHealth();

  if (transportError) {
    fail("health reachable", describeError(transportError));
    return;
  }

  if (isProtectionBlocked(response)) {
    fail("health reachable", describeProtectionBlock());
    return;
  }

  let payload;

  try {
    payload = JSON.parse(body);
  } catch {
    fail("health reachable", `HTTP ${response.status} with a non-JSON body: ${body.slice(0, 120)}`);
    return;
  }

  pass("health reachable", `HTTP ${response.status}`);

  for (const [name, state] of Object.entries(payload.checks ?? {})) {
    if (state === "ok") {
      pass(`connector ${name}`, "ok");
    } else {
      fail(`connector ${name}`, `reported "${state}"`);
    }
  }

  if (!payload.checks || Object.keys(payload.checks).length === 0) {
    fail("health payload", "response carried no checks — nothing was actually verified");
  }
};

const checkHomepage = async () => {
  try {
    const response = await fetch(baseUrl, { headers: requestHeaders });

    if (isProtectionBlocked(response)) {
      fail("homepage renders", describeProtectionBlock());
      return;
    }

    if (!response.ok) {
      fail("homepage renders", `HTTP ${response.status}`);
      return;
    }

    const body = await response.text();

    if (body.toLowerCase().includes(APP_MARKER)) {
      pass("homepage renders", `HTTP ${response.status}, served by the app`);
    } else {
      fail(
        "homepage renders",
        `HTTP ${response.status} but the body carries no "${APP_MARKER}" marker — something other than the app answered`,
      );
    }
  } catch (error) {
    fail("homepage renders", describeError(error));
  }
};

console.log(`smoke target: ${baseUrl}`);
console.log(bypassSecret ? "protection bypass: configured\n" : "protection bypass: not set\n");

await checkHealth();
await checkHomepage();

console.log(
  failures === 0
    ? "\nRESULT: deployment is serving and every connector reports ok"
    : `\nRESULT: FAILED — ${failures} check(s) failed`,
);

process.exit(failures === 0 ? 0 : 1);
