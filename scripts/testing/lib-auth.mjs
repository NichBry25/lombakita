import { BASE, MFA_FACTOR_SECRET_HEX, PASSWORD } from "./seeds.mjs";
import { generateTotpCode } from "./lib-totp.mjs";

const parseSetCookies = (res, jar) => {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
};

export const cookieHeader = (jar) =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * Logs in via the NextAuth v4 credentials HTTP flow.
 * Returns { ok, cookie, jar, error } — error is the next-auth error token when login fails
 * (INVALID_CREDENTIALS / ACCOUNT_SUSPENDED / EMAIL_NOT_VERIFIED / RATE_LIMITED / CredentialsSignin).
 */
export async function mintSession(email, password = PASSWORD) {
  const jar = new Map();

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  parseSetCookies(csrfRes, jar);
  const { csrfToken } = await csrfRes.json();

  const body = new URLSearchParams({ csrfToken, email, password, json: "true" });
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(jar),
    },
    body,
    redirect: "manual",
  });
  parseSetCookies(loginRes, jar);

  let redirectUrl = loginRes.headers.get("location") ?? "";
  if (!redirectUrl && loginRes.headers.get("content-type")?.includes("json")) {
    try {
      const data = await loginRes.json();
      redirectUrl = data?.url ?? "";
    } catch {
      /* ignore */
    }
  }
  const errorMatch = redirectUrl.match(/error=([^&]+)/);
  const hasSession = [...jar.keys()].some((k) => k.includes("session-token"));

  return {
    ok: hasSession && !errorMatch,
    cookie: cookieHeader(jar),
    jar,
    error: errorMatch ? decodeURIComponent(errorMatch[1]) : null,
    status: loginRes.status,
  };
}

/**
 * Drives a freshly minted operational session through a real TOTP challenge so it reaches
 * `mfaStatus: "satisfied"` — the state a human operator is in after typing a code, and the only
 * state in which /admin surfaces render.
 *
 * It runs the production path end to end rather than forging a claim: the challenge endpoint
 * verifies the code and mints an opaque single-use elevation grant, and the jwt callback's `update`
 * trigger is what turns that grant into `mfaVerifiedAt`. There is deliberately no shortcut — the
 * whole point of the grant is that a client cannot assert its own elevation, so a harness that
 * could would be testing a different application.
 *
 * Mutates `jar` in place, because the update response reissues the session cookie.
 */
export async function elevateMfaSession(jar) {
  const code = generateTotpCode(Buffer.from(MFA_FACTOR_SECRET_HEX, "hex"));

  const challengeRes = await fetch(`${BASE}/api/v1/auth/mfa/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
    body: JSON.stringify({ code }),
  });
  if (!challengeRes.ok) {
    const detail = await challengeRes.text();
    throw new Error(`MFA challenge failed (${challengeRes.status}): ${detail.slice(0, 160)}`);
  }
  const { elevationGrantId } = await challengeRes.json();

  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } });
  parseSetCookies(csrfRes, jar);
  const { csrfToken } = await csrfRes.json();

  const updateRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
    body: JSON.stringify({ csrfToken, data: { mfaElevationGrant: elevationGrantId } }),
  });
  parseSetCookies(updateRes, jar);
  if (!updateRes.ok) {
    throw new Error(`MFA session update failed (${updateRes.status})`);
  }
  return cookieHeader(jar);
}

/** Fetch with a session cookie; returns { status, body (parsed json or text), contentType }. */
export async function apiFetch(path, { method = "GET", cookie = "", headers = {}, json } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect: "manual",
  });
  const contentType = res.headers.get("content-type") ?? "";
  let body;
  const text = await res.text();
  if (contentType.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = text;
  }
  return { status: res.status, body, contentType, location: res.headers.get("location") };
}
