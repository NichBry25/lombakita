import { BASE, PASSWORD } from "./seeds.mjs";

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
