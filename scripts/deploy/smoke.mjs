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

const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

const requestHeaders = bypassSecret
  ? { "x-vercel-protection-bypass": bypassSecret, "x-vercel-set-bypass-cookie": "true" }
  : {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

const pass = (label, detail) => {
  console.log(`  PASS  ${label.padEnd(22)} ${detail ?? ""}`.trimEnd());
};

const fail = (label, detail) => {
  failures += 1;
  console.log(`  FAIL  ${label.padEnd(22)} ${detail}`);
};

const describeProtectionBlock = (status) =>
  `HTTP ${status} — Vercel Deployment Protection is intercepting this request. ` +
  "Set VERCEL_AUTOMATION_BYPASS_SECRET (Project Settings → Deployment Protection → " +
  "Protection Bypass for Automation) or disable protection for this environment.";

const isProtectionBlock = (status) => status === 401;

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
    fail("health reachable", `${transportError.name}: ${transportError.message}`);
    return;
  }

  if (isProtectionBlock(response.status)) {
    fail("health reachable", describeProtectionBlock(response.status));
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

    if (isProtectionBlock(response.status)) {
      fail("homepage renders", describeProtectionBlock(response.status));
      return;
    }

    if (response.ok) {
      pass("homepage renders", `HTTP ${response.status}`);
    } else {
      fail("homepage renders", `HTTP ${response.status}`);
    }
  } catch (error) {
    fail("homepage renders", `${error.name}: ${error.message}`);
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
