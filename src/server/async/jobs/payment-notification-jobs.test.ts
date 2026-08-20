// @vitest-environment node
//
// What the two manual-lane workers SAY, and WHO they say it to.
//
// The wiring — that the four call sites reach the queue at all, with the right payload, through the
// real service and a real database — is proven in `manual-lane-db.integration.test.ts`. What that
// suite cannot see is the copy, because the copy is written inside the worker. This file measures
// the strings and the fan-out, and mocks nothing below the two boundaries it needs: the recipient
// resolvers (their own scoping is asserted against a real database elsewhere) and Resend.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const {
  mockGetDb,
  mockWriteNotification,
  mockSendPaymentProofSubmittedEmail,
  mockSendPaymentOutcomeEmail,
  mockListInstitutionAdminUserIds,
  mockResolvePaymentGroupMemberUserIds,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockWriteNotification: vi.fn(),
  mockSendPaymentProofSubmittedEmail: vi.fn(),
  mockSendPaymentOutcomeEmail: vi.fn(),
  mockListInstitutionAdminUserIds: vi.fn(),
  mockResolvePaymentGroupMemberUserIds: vi.fn(),
}));

vi.mock("@/server/db/client", () => ({ getDb: mockGetDb }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
// Only the throwing primitive is replaced, so the real `writeInboxNotificationSafely` wrapper runs
// and its swallow behaviour is exercised rather than stubbed away.
vi.mock("@/server/notifications/notification-service", () => ({
  writeNotification: mockWriteNotification,
}));
vi.mock("@/server/notifications/notification-email", () => ({
  sendPaymentProofSubmittedEmail: mockSendPaymentProofSubmittedEmail,
  sendPaymentOutcomeEmail: mockSendPaymentOutcomeEmail,
}));
vi.mock("@/server/institution-members/member-service", () => ({
  listInstitutionAdminUserIds: mockListInstitutionAdminUserIds,
}));
vi.mock("@/server/finance/paid-registration", () => ({
  resolvePaymentGroupMemberUserIds: mockResolvePaymentGroupMemberUserIds,
}));

import {
  processPaymentProofSubmittedJob,
  type PaymentProofSubmittedJob,
} from "./payment-proof-submitted";
import { processPaymentOutcomeJob, type PaymentOutcomeJob } from "./payment-outcome";
import type { PaymentOutcomePayload } from "@/server/async/contracts";

/**
 * Chain mock — each select() shifts the next canned result; thenable so a where-terminated read
 * resolves.
 *
 * IT ALSO CAPTURES THE CONDITION, and that is not decoration. A mock that ignores `where` returns
 * its canned rows no matter what the worker asked for, so a fan-out cut down to one recipient still
 * produces four notifications and the test reports a guard it never touched. The captured condition
 * is rendered to SQL below, which is the only place the ASKED-FOR set is observable.
 */
function makeDb(queue: unknown[][]) {
  const captured: unknown[] = [];
  const db = {
    capturedConditions: captured,
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: (condition: unknown) => {
          captured.push(condition);
          return chain;
        },
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  };
  return db;
}

/** The literal values a captured Drizzle condition would send to Postgres. */
const paramsOf = (condition: unknown): unknown[] =>
  new PgDialect().sqlToQuery(condition as Parameters<PgDialect["sqlToQuery"]>[0]).params;

const submittedJob = (): PaymentProofSubmittedJob =>
  ({
    id: "job_sub",
    data: {
      paymentId: "pay_1",
      proofId: "proof_1",
      attempt: 0,
      competitionTitle: "Seed Coding League",
      institutionSlug: "seed-academy",
      competitionSlug: "seed-coding-league",
      institutionId: "inst_1",
      payerDisplayName: "Sari Melati",
      grossAmount: 150_000,
      currency: "IDR",
    },
  }) as unknown as PaymentProofSubmittedJob;

const outcomeJob = (overrides: Partial<PaymentOutcomePayload> = {}): PaymentOutcomeJob =>
  ({
    id: "job_out",
    data: {
      paymentId: "pay_1",
      registrationId: "reg_1",
      attempt: 0,
      competitionTitle: "Seed Coding League",
      outcome: "verified",
      rejectionReason: null,
      resubmissionAllowed: null,
      grossAmount: 150_000,
      currency: "IDR",
      ...overrides,
    },
  }) as unknown as PaymentOutcomeJob;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the bukti transfer submission notice", () => {
  it("reaches every administrator of the owning institution, once each", async () => {
    mockListInstitutionAdminUserIds.mockResolvedValue(["u_owner", "u_staff"]);
    const db = makeDb([
      [
        { id: "u_owner", email: "owner@test.com" },
        { id: "u_staff", email: "staff@test.com" },
      ],
    ]);
    mockGetDb.mockReturnValue(db);

    await processPaymentProofSubmittedJob(submittedJob());

    expect(mockListInstitutionAdminUserIds).toHaveBeenCalledWith("inst_1", expect.anything());
    // Same reasoning as the verdict fan-out: the asked-for set, not the canned answer.
    expect(paramsOf(db.capturedConditions[0])).toEqual(["u_owner", "u_staff"]);
    expect(mockWriteNotification).toHaveBeenCalledTimes(2);
    expect(mockSendPaymentProofSubmittedEmail).toHaveBeenCalledTimes(2);
  });

  it("says who paid, how much, and what to do — in Indonesian", async () => {
    mockListInstitutionAdminUserIds.mockResolvedValue(["u_owner"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_owner", email: "owner@test.com" }]]));

    await processPaymentProofSubmittedJob(submittedJob());

    const [, , , title, body] = mockWriteNotification.mock.calls[0]!;
    expect(title).toBe("Bukti transfer baru untuk Seed Coding League");
    expect(body).toContain("Sari Melati");
    expect(body).toContain("Rp 150.000");
    expect(body).toContain("Tinjau dan beri keputusan.");
  });

  it("does nothing, and does not throw, when the institution has no administrator left", async () => {
    // A real state — the last admin membership was revoked — and not one a retry can fix.
    mockListInstitutionAdminUserIds.mockResolvedValue([]);
    mockGetDb.mockReturnValue(makeDb([]));

    await expect(processPaymentProofSubmittedJob(submittedJob())).resolves.toBeUndefined();

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendPaymentProofSubmittedEmail).not.toHaveBeenCalled();
  });

  it("still emails when the inbox write fails", async () => {
    mockListInstitutionAdminUserIds.mockResolvedValue(["u_owner"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_owner", email: "owner@test.com" }]]));
    mockWriteNotification.mockRejectedValueOnce(new Error("db down"));

    await expect(processPaymentProofSubmittedJob(submittedJob())).resolves.toBeUndefined();

    expect(mockSendPaymentProofSubmittedEmail).toHaveBeenCalledTimes(1);
  });

  it("rethrows an email failure so BullMQ retries it", async () => {
    mockListInstitutionAdminUserIds.mockResolvedValue(["u_owner"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_owner", email: "owner@test.com" }]]));
    mockSendPaymentProofSubmittedEmail.mockRejectedValueOnce(new Error("resend down"));

    await expect(processPaymentProofSubmittedJob(submittedJob())).rejects.toThrow("resend down");
  });
});

describe("the payment verdict notice", () => {
  const fourMembers = [
    { id: "u_captain", email: "captain@test.com" },
    { id: "u_2", email: "m2@test.com" },
    { id: "u_3", email: "m3@test.com" },
    { id: "u_4", email: "m4@test.com" },
  ];

  it("reaches every member of the team, not the captain who paid alone (R13)", async () => {
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue(fourMembers.map((m) => m.id));
    const db = makeDb([fourMembers]);
    mockGetDb.mockReturnValue(db);

    await processPaymentOutcomeJob(outcomeJob());

    expect(mockResolvePaymentGroupMemberUserIds).toHaveBeenCalledWith("reg_1", expect.anything());
    // The set the worker ASKED FOR, not the set the mock happened to answer with. Narrowing the
    // fan-out to the captain leaves this assertion holding one id.
    expect(paramsOf(db.capturedConditions[0])).toEqual([
      "u_captain",
      "u_2",
      "u_3",
      "u_4",
    ]);
    expect(mockWriteNotification).toHaveBeenCalledTimes(4);
    expect(mockSendPaymentOutcomeEmail).toHaveBeenCalledTimes(4);
  });

  it("tells a verified payer their registration is active, with nothing left to do", async () => {
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue(["u_1"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_1", email: "a@test.com" }]]));

    await processPaymentOutcomeJob(outcomeJob({ outcome: "verified" }));

    const [, , , title, body] = mockWriteNotification.mock.calls[0]!;
    expect(title).toBe("Pembayaran diverifikasi untuk Seed Coding League");
    expect(body).toContain("Rp 150.000");
    expect(body).toContain("Pendaftaran Anda aktif.");
  });

  it("gives a rejected payer the reason and tells them to send a new proof", async () => {
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue(["u_1"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_1", email: "a@test.com" }]]));

    await processPaymentOutcomeJob(
      outcomeJob({
        outcome: "rejected",
        rejectionReason: "Nominal transfer tidak sesuai",
        resubmissionAllowed: true,
      }),
    );

    const [, , , title, body] = mockWriteNotification.mock.calls[0]!;
    expect(title).toBe("Bukti transfer ditolak untuk Seed Coding League");
    expect(body).toContain("Alasan: Nominal transfer tidak sesuai.");
    expect(body).toContain("Unggah bukti transfer yang baru");
  });

  it("does not invite a barred payer to resubmit", async () => {
    // The bar is enforced in the reopen CAS. A notice that says "try again" over a path that
    // refuses is how a payer spends their remaining days on an action that cannot work.
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue(["u_1"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_1", email: "a@test.com" }]]));

    await processPaymentOutcomeJob(
      outcomeJob({
        outcome: "rejected",
        rejectionReason: "Bukan transfer ke rekening kami",
        resubmissionAllowed: false,
      }),
    );

    const [, , , , body] = mockWriteNotification.mock.calls[0]!;
    expect(body).toContain("Anda tidak dapat mengirim bukti baru");
    expect(body).toContain("hubungi penyelenggara");
    expect(body).not.toContain("Unggah bukti transfer yang baru");
  });

  it("attributes an expiry to the deadline and to nobody else", async () => {
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue(["u_1"]);
    mockGetDb.mockReturnValue(makeDb([[{ id: "u_1", email: "a@test.com" }]]));

    await processPaymentOutcomeJob(outcomeJob({ outcome: "expired" }));

    const [, , , title, body] = mockWriteNotification.mock.calls[0]!;
    expect(title).toBe("Pendaftaran dibatalkan otomatis untuk Seed Coding League");
    expect(body).toContain("secara otomatis");
    expect(body).toContain("Ini bukan keputusan penyelenggara.");
    // The words that would make a deadline read as a verdict.
    expect(body).not.toContain("ditolak");
    expect(body).not.toContain("Penyelenggara menolak");
  });

  it("does nothing, and does not throw, when the payment group resolves to nobody", async () => {
    mockResolvePaymentGroupMemberUserIds.mockResolvedValue([]);
    mockGetDb.mockReturnValue(makeDb([]));

    await expect(processPaymentOutcomeJob(outcomeJob())).resolves.toBeUndefined();

    expect(mockWriteNotification).not.toHaveBeenCalled();
    expect(mockSendPaymentOutcomeEmail).not.toHaveBeenCalled();
  });
});
