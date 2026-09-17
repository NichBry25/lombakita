/*
 * What the browser and API harnesses must establish BEFORE they assert anything.
 *
 * Two refusals, and neither is a skip. A harness that reports a missing precondition as a per-case
 * failure has produced a report no reader can act on: 31 surfaces of missing text where the answer
 * is one command.
 *
 * ── 1. The app is listening ─────────────────────────────────────────────────────────────────────
 * The old check measured `/api/health` against a fixed budget and called the expiry "Nothing is
 * serving". That conflates two different worlds: a port nobody answers, and a port that answers
 * slowly. The second is a real state (a dev server cold-compiling) and the harness reported it as
 * the first, which is how a healthy app gets called dead. The socket decides that question, not a
 * timeout: a refused TCP connect is absence, and it is absence whatever the budget would have been.
 * Only after something is listening does a slow answer mean slow.
 *
 * ── 2. The database holds the fixtures ──────────────────────────────────────────────────────────
 * `npm run db:reset` writes the testing matrix as its fifth step of seven. The operator accounts and
 * the manual bukti-transfer lane are OPT-IN and are not part of it, so a reset-only database has no
 * `platform_ops` login and no finance row, while the harnesses go on describing both. Measured by
 * running `ui-states.mjs` against a reset-only database: 45 misses across 31 surfaces, every one of
 * them a sentence about a surface failing to render. The fix is one refusal naming the command that
 * was not run.
 *
 * WHY THIS ASKS THE DATABASE AND NOT THE APP. The role gate runs before the resource lookup on every
 * money-lane route, so a refused caller gets the same answer whether the proof exists or not. Where
 * the question is "is this fixture really there", no response from a refused caller can answer it.
 *
 * READ ONLY. Every function here opens one connection, runs SELECTs, and closes it in a `finally`.
 * It deliberately does not reuse the probe harness's throwaway-database module, which creates and
 * drops databases and has no business in a harness that only reads.
 */
import postgres from "postgres";

import { isLoopbackUrl, parseDatabaseHost } from "../lib/loopback-host.mjs";

/** The three commands the harnesses assume, in the order they have to run. */
const SEED_COMMANDS = ["npm run db:reset", "npm run db:seed:operators", "npm run db:seed:payments"];

const SEED_COMMAND_BLOCK = SEED_COMMANDS.map((command) => `  ${command}`).join("\n");

/**
 * Says the same thing about both refusals, because the reader's next move is the same either way.
 *
 * Printed rather than thrown so the message reaches the terminal without a stack trace over it, and
 * exited rather than returned so no caller can proceed past it by accident.
 */
const refuse = (detail) => {
  console.error(detail);
  process.exit(1);
};

// ── the app is listening ────────────────────────────────────────────────────────────────────────

/**
 * Whether anything is listening on a host and port, decided at the socket.
 *
 * `ECONNREFUSED` is absence and is budget-independent: it arrives as fast as the kernel can answer,
 * whether the budget was one second or ninety. A CONNECT that succeeds and then goes quiet is not
 * absence at all — it is the app being slow — and the caller must say so instead of reporting a
 * dead server.
 */
export const nothingIsListening = async (baseUrl, budgetMs = 5_000) => {
  const { hostname, port } = new URL(baseUrl);
  const { connect } = await import("node:net");

  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    let settled = false;

    const conclude = (absent, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(absent ? { absent: true, reason } : { absent: false });
    };

    socket.setTimeout(budgetMs);
    socket.once("connect", () => conclude(false));
    socket.once("timeout", () => conclude(false, "the socket accepted the connection and idled"));
    socket.once("error", (error) => conclude(true, error.code ?? String(error)));
  });
};

/**
 * Which of the four states a URL is in, as a value rather than a refusal.
 *
 * Split out from `assertAppReachable` so a probe can drive the real decision without `process.exit`
 * taking the harness down with it. The budgets are parameters for the same reason: what is under
 * test is the CLASSIFICATION — a silent port is slow, not absent — and that property does not
 * depend on how long the budget is.
 */
export const classifyAppReachability = async (
  baseUrl,
  { socketBudgetMs = 5_000, warmBudgetMs = 90_000, measureBudgetMs = 10_000 } = {},
) => {
  const absence = await nothingIsListening(baseUrl, socketBudgetMs);
  if (absence.absent) return { state: "absent", detail: absence.reason };

  // SOMETHING IS LISTENING, so a slow answer from here on is slow, not absent. Warmed first for the
  // same reason every case route is: `/api/health` is a route like any other and cold-compiles.
  await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(warmBudgetMs) }).catch(
    () => {},
  );

  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(measureBudgetMs),
    });

    // Any answer proves the app is serving. `degraded` is fine: these assertions read pages and
    // routes, not connectors.
    if (response.status !== 200 && response.status !== 503) {
      return { state: "unexpected", detail: `status ${response.status}` };
    }

    return { state: "serving", detail: `status ${response.status}` };
  } catch (error) {
    return { state: "slow", detail: String(error).slice(0, 120) };
  }
};

/**
 * Refuses a URL that is not a local one, before any of it is fetched.
 *
 * These harnesses mint sessions for seeded accounts with a published password, and the refusal
 * below tells the reader to seed a database. Neither is advice to follow against a deployed
 * environment. `BASE_URL` overrides the default, so the check is on the value actually used.
 */
const refuseRemoteApp = (baseUrl) => {
  const host = parseDatabaseHost(baseUrl);

  if (host !== null && isLoopbackUrl(baseUrl)) return;
  if (host === null) {
    refuse(`BASE_URL is not a URL this harness can read: ${JSON.stringify(baseUrl)}`);
  }

  refuse(
    `BASE_URL points at ${host}, which is not this machine.\n` +
      "These harnesses sign in as seeded accounts and are run against a local app only.",
  );
};

/**
 * Refuses unless the app is up, and says WHICH of the two states it found.
 *
 * The distinction is the whole point. "Nothing is listening" is an absence the reader fixes by
 * starting something; "the app is listening and did not answer" is a slow app the reader fixes by
 * waiting or by looking at the app. Reporting the second as the first sends them to the wrong place,
 * and it is the reason a healthy app under load was once called dead by this harness.
 */
export const assertAppReachable = async (baseUrl) => {
  refuseRemoteApp(baseUrl);

  const verdict = await classifyAppReachability(baseUrl);

  if (verdict.state === "absent") {
    refuse(
      `Nothing is listening on ${baseUrl} (${verdict.detail}).\n` +
        "These assertions need the app RUNNING and the database SEEDED:\n" +
        SEED_COMMAND_BLOCK +
        "\n  npm run dev\n" +
        "This is a FAILURE, not a skip. A UI-state harness that quietly passes when the app is " +
        "absent reports success for every surface it was supposed to be checking.",
    );
  }

  if (verdict.state === "slow") {
    refuse(
      `${baseUrl} is LISTENING and /api/health did not answer within the budget, after a warm-up ` +
        `(${verdict.detail}).\n` +
        "That is SLOW, not ABSENT — the port is open and something accepted the connection, so " +
        "the app is running. Look at the app, or re-run once it has settled, rather than at " +
        "whether anything is listening.",
    );
  }

  if (verdict.state === "unexpected") {
    refuse(
      `${baseUrl} is listening, but /api/health answered ${verdict.detail}, which is neither the ` +
        "healthy nor the degraded response this harness knows how to read.",
    );
  }
};

// ── the database holds the fixtures ─────────────────────────────────────────────────────────────

/**
 * The connection string the app itself reads, refused unless it is local.
 *
 * `.env.local` is loaded only when the variable is not already set, so an explicit environment
 * always wins — which is what lets CI point this at its own service container.
 */
const localDatabaseUrl = () => {
  let url = process.env.DATABASE_URL;

  if (!url) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // Absent in CI, where the workflow environment supplies these instead.
    }
    url = process.env.DATABASE_URL;
  }

  if (!url) {
    refuse(
      "DATABASE_URL is not set, so this harness cannot tell whether the fixtures it is about to " +
        "describe exist. It reads the same .env.local the app does.",
    );
  }

  if (!isLoopbackUrl(url)) {
    refuse(
      `DATABASE_URL points at ${parseDatabaseHost(url)}, which is not this machine.\n` +
        "This harness reads the fixtures it asserts against, and it is run against a local " +
        "database only.",
    );
  }

  return url;
};

/**
 * One connection, one read, closed in a `finally`.
 *
 * Opened per call rather than held for the run, so there is no pool for a harness to leak and no
 * `process.exit` that can skip the close. The reads here happen once or twice per run.
 */
const withDatabase = async (read) => {
  const sql = postgres(localDatabaseUrl(), { max: 1, idle_timeout: 1 });

  try {
    return await read(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/**
 * The two opt-in lanes, each with the command that writes it and the question that detects it.
 *
 * `finance_payments` is counted unqualified on purpose. The matrix seed writes no finance row —
 * that is a locked property of the split, asserted by the lane seed itself — so every row in that
 * table is the opt-in lane's, and no id spelling has to be guessed here.
 */
const OPT_IN_LANES = [
  {
    command: "npm run db:seed:operators",
    describes: "the operator accounts and their MFA factors",
    count: (sql) =>
      sql`SELECT count(*)::int AS n FROM users WHERE role IN ('platform_ops', 'finance_ops')`,
  },
  {
    command: "npm run db:seed:payments",
    describes: "the manual bukti-transfer lane",
    count: (sql) => sql`SELECT count(*)::int AS n FROM finance_payments`,
  },
];

/**
 * Refuses, once, when the database does not hold the lanes these harnesses describe.
 *
 * The matrix is deliberately not a third lane: `npm run db:reset` writes it as its fifth step of
 * seven, and it is the matrix that writes the accounts the operator seed then reviews, so a
 * database missing the matrix is missing the operator lane too and is named by the same refusal.
 */
export const assertSeedLanesPresent = async () => {
  const absent = await withDatabase(async (sql) => {
    const missing = [];

    for (const lane of OPT_IN_LANES) {
      const [row] = await lane.count(sql);
      if (row.n === 0) missing.push(lane);
    }

    return missing;
  });

  if (absent.length === 0) return;

  const named = absent.map((lane) => `  missing: ${lane.describes}  (${lane.command})`).join("\n");

  refuse(
    "The database these assertions describe has not been seeded with its opt-in lanes:\n" +
      `${named}\n\n` +
      "Run the three commands, in this order, against the database the app is using:\n" +
      `${SEED_COMMAND_BLOCK}\n\n` +
      "This is a FAILURE, not a skip. Without these rows every money-lane case below reads a " +
      "fixture that is not there and reports it as a product defect, which is a report no reader " +
      "can act on.",
  );
};

/**
 * The tables a seeded fixture id can live in, for the controls below.
 *
 * A fixed list rather than a parameter: a caller that names its own table is a caller that can name
 * the wrong one and be told its fixture is missing. Seed ids are unique across the matrix and the
 * opt-in lane, so an id found in none of these is an id that was not seeded.
 */
const FIXTURE_TABLES = [
  "institutions",
  "competitions",
  "competition_registrations",
  "institution_payment_instructions",
  "finance_fee_rules",
  "finance_fee_accruals",
  "finance_payments",
  "finance_manual_payment_proofs",
];

/**
 * Which of the named fixtures are NOT in the database.
 *
 * Exists for the NEGATIVE cases, which cannot answer the question themselves. The role gate runs
 * before the resource lookup on every money-lane route, so a wrong-role caller gets the same 403
 * whether the proof is there or not — and a UI page whose fixture is absent renders no control for
 * anyone, which is indistinguishable from a control correctly withheld. An empty result is what
 * makes such a refusal evidence of the boundary rather than evidence of a missing fixture.
 *
 * Fails closed: an id that is real but lives in a table this list does not name reads as missing,
 * which is a refusal rather than a case passing for a reason nobody chose.
 */
export const missingFixtures = async (fixtureIds) => {
  if (fixtureIds.length === 0) return [];

  const found = await withDatabase(async (sql) => {
    const present = new Set();

    for (const table of FIXTURE_TABLES) {
      const rows = await sql`SELECT id FROM ${sql(table)} WHERE id IN ${sql(fixtureIds)}`;
      for (const row of rows) present.add(row.id);
    }

    return present;
  });

  return fixtureIds.filter((id) => !found.has(id));
};

/** The commands themselves, so a harness's own notes quote the same list this module refuses with. */
export const seedCommands = () => [...SEED_COMMANDS];
