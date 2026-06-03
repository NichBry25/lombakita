// @vitest-environment node
//
// Step 6.5.1 — listUserInbox + countUnreadInboxItems unit tests.
//
// The project does not run live-DB integration tests, so behavioural filtering (tenant isolation,
// null-target exclusion, expiry exclusion) is proven two ways here: (1) the merge/sort/shape of the
// returned items given canned rows, and (2) by rendering the actual WHERE conditions the service
// hands to Drizzle and asserting they scope by user/target_user_id, status='pending', and
// expires_at > now. The live row-level behaviour is re-verified by the manual checklist at step 9.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDb: vi.fn() }));

import { countUnreadInboxItems, listUserInbox } from "./inbox-service";

const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as never);

// Chain mock: each select() shifts the next canned result set and records the WHERE condition it is
// given. The chain is thenable (so a query terminated by .where() resolves) and also resolves on
// .limit().
function makeInboxDb(resultQueue: unknown[][], whereSink: unknown[]) {
  let i = 0;
  const select = () => {
    const rows = resultQueue[i++] ?? [];
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: (cond: unknown) => {
        whereSink.push(cond);
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  };
  return { select } as never;
}

const notifRow = (overrides: Record<string, unknown> = {}) => ({
  id: "n1",
  type: "registration_confirmed",
  title: "Pendaftaran Dikonfirmasi",
  body: "Pendaftaranmu telah dikonfirmasi.",
  readAt: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

const instRow = (overrides: Record<string, unknown> = {}) => ({
  id: "i1",
  institutionName: "Universitas Contoh",
  invitedRole: "institution_staff",
  expiresAt: new Date("2026-07-01T00:00:00.000Z"),
  createdAt: new Date("2026-06-02T00:00:00.000Z"),
  ...overrides,
});

const teamRow = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  teamName: "Tim Hebat",
  competitionTitle: "Hackathon 2026",
  expiresAt: new Date("2026-07-01T00:00:00.000Z"),
  createdAt: new Date("2026-05-30T00:00:00.000Z"),
  ...overrides,
});

describe("listUserInbox", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the user's own notifications with the notification discriminant", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[notifRow()], [], []], whereSink);

    const items = await listUserInbox("user_1", db);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notification",
      id: "n1",
      title: "Pendaftaran Dikonfirmasi",
      readAt: null,
    });
  });

  it("scopes the notification query by the requesting user (tenant isolation)", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[], [], []], whereSink);

    await listUserInbox("user_1", db);

    // First WHERE is the notifications query — it must bind user_1 on user_id, so another user's
    // rows can never be returned.
    const notifCond = render(whereSink[0]);
    expect(notifCond.sql).toContain('"user_id"');
    expect(notifCond.params).toContain("user_1");
  });

  it("surfaces pending invitations resolved by target_user_id (not invited_email) and excludes expired", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[], [instRow()], [teamRow()]], whereSink);

    const items = await listUserInbox("user_1", db);

    expect(items.map((x) => x.kind).sort()).toEqual(["institution_invite", "team_invite"]);

    // Institution-invite WHERE (2nd) and team-invite WHERE (3rd): both query by target_user_id,
    // require status='pending', and require expires_at > now. target_user_id equality inherently
    // excludes NULL targets; the expires_at predicate excludes expired invitations.
    for (const cond of [render(whereSink[1]), render(whereSink[2])]) {
      expect(cond.sql).toContain('"target_user_id"');
      expect(cond.sql).not.toContain('"invited_email"');
      expect(cond.params).toContain("user_1");
      expect(cond.params).toContain("pending");
      expect(cond.sql).toMatch(/"expires_at"\s*>/);
    }
  });

  it("merges all three sources sorted by createdAt descending", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[notifRow()], [instRow()], [teamRow()]], whereSink);

    const items = await listUserInbox("user_1", db);

    // i1 (06-02) > n1 (06-01) > t1 (05-30)
    expect(items.map((x) => x.id)).toEqual(["i1", "n1", "t1"]);
  });
});

describe("countUnreadInboxItems", () => {
  afterEach(() => vi.clearAllMocks());

  it("sums unread notifications plus pending invitations", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[{ value: 2 }], [{ value: 1 }], [{ value: 1 }]], whereSink);

    const total = await countUnreadInboxItems("user_1", db);

    expect(total).toBe(4);
  });

  it("filters notifications to unread rows for the requesting user", async () => {
    const whereSink: unknown[] = [];
    const db = makeInboxDb([[{ value: 0 }], [{ value: 0 }], [{ value: 0 }]], whereSink);

    await countUnreadInboxItems("user_1", db);

    const unreadCond = render(whereSink[0]);
    expect(unreadCond.sql).toContain('"user_id"');
    expect(unreadCond.params).toContain("user_1");
    expect(unreadCond.sql).toMatch(/"read_at"\s+is null/i);
  });
});
