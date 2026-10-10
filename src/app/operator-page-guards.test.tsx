import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRedirectError } from "next/dist/client/components/redirect";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  getDb: vi.fn(),
  featured: vi.fn(),
  feeRules: vi.fn(),
  blocked: vi.fn(),
  barred: vi.fn(),
  payments: vi.fn(),
  detail: vi.fn(),
  ledger: vi.fn(),
}));
vi.mock("@/server/auth/page-guard", () => ({ requireRolePage: mocks.guard }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/components/ui", () => ({
  PageHeader: () => null,
  Feedback: () => null,
  EmptyState: () => null,
  Icon: () => null,
  Card: () => null,
}));
vi.mock("@/server/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/finance/fee-rule-service", () => ({ listFeeRules: mocks.feeRules }));
vi.mock("@/server/finance/ops-payment-review", () => ({
  loadOpsBlockedCompetitions: mocks.blocked,
  loadOpsBarredProofs: mocks.barred,
}));
vi.mock("@/server/finance/dispute-view", () => ({
  loadDisputePayments: mocks.payments,
  loadDisputePaymentDetail: mocks.detail,
  loadDisputeLedgerState: mocks.ledger,
}));
vi.mock("./admin/featured/featured-row-form", () => ({ FeaturedRowForm: () => null }));
vi.mock("./admin/fee-rules/fee-rule-form", () => ({ FeeRuleForm: () => null }));
vi.mock("./admin/payments/ops-payment-actions", () => ({ OpsPaymentActions: () => null }));
vi.mock("./admin/moderation/moderation-console", () => ({ ModerationConsole: () => null }));
vi.mock("./finance/payments/[paymentId]/dispute-proof-file-button", () => ({
  DisputeProofFileButton: () => null,
}));

const READERS = [
  mocks.getDb,
  mocks.featured,
  mocks.feeRules,
  mocks.blocked,
  mocks.barred,
  mocks.payments,
  mocks.detail,
  mocks.ledger,
];
const CASES = [
  {
    path: "/admin",
    role: "platform_ops",
    readers: [],
    run: async () => (await import("./admin/page")).default(),
  },
  {
    path: "/admin/featured",
    role: "platform_ops",
    readers: [mocks.getDb, mocks.featured],
    run: async () => (await import("./admin/featured/page")).default(),
  },
  {
    path: "/admin/fee-rules",
    role: "platform_ops",
    readers: [mocks.feeRules],
    run: async () => (await import("./admin/fee-rules/page")).default(),
  },
  {
    path: "/admin/moderation",
    role: "platform_ops",
    readers: [],
    run: async () =>
      (await import("./admin/moderation/page")).default({ searchParams: Promise.resolve({}) }),
  },
  {
    path: "/admin/payments",
    role: "platform_ops",
    readers: [mocks.blocked, mocks.barred],
    run: async () => (await import("./admin/payments/page")).default(),
  },
  {
    path: "/finance",
    role: "finance_ops",
    readers: [],
    run: async () => (await import("./finance/page")).default(),
  },
  {
    path: "/finance/payments",
    role: "finance_ops",
    readers: [mocks.payments],
    run: async () => (await import("./finance/payments/page")).default(),
  },
  {
    path: "/finance/payments/[paymentId]",
    callbackPath: "/finance/payments",
    role: "finance_ops",
    readers: [mocks.detail, mocks.ledger],
    run: async () =>
      (await import("./finance/payments/[paymentId]/page")).default({
        params: Promise.resolve({ paymentId: "test-payment" }),
      }),
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue(undefined);
  for (const reader of [
    mocks.featured,
    mocks.feeRules,
    mocks.blocked,
    mocks.barred,
    mocks.payments,
  ]) {
    reader.mockResolvedValue([]);
  }
  const query = {
    select: vi.fn(),
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: mocks.featured,
  };
  for (const method of [query.select, query.from, query.innerJoin, query.where])
    method.mockReturnValue(query);
  mocks.getDb.mockReturnValue(query);
  mocks.detail.mockResolvedValue({
    competitionTitle: "Test",
    payerDisplayName: "Test",
    institutionSlug: "test",
    grossAmount: 0,
    currency: "IDR",
    dueAt: null,
    proofId: null,
    history: [],
  });
  mocks.ledger.mockResolvedValue({ status: "pending", netRecordedAmount: 0, currency: "IDR" });
});

describe.each(CASES)("operator page $path", (entry) => {
  it("refuses before reading data when the role guard redirects", async () => {
    const refusal = getRedirectError("/auth/login?callbackUrl=%2Fadmin", "replace");
    mocks.guard.mockRejectedValue(refusal);
    await expect(entry.run()).rejects.toBe(refusal);
    expect(mocks.guard).toHaveBeenCalledExactlyOnceWith(entry.role, {
      callbackPath: entry.callbackPath ?? entry.path,
    });
    for (const reader of READERS) expect(reader).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("reads exactly once when the role guard resolves", async () => {
    await entry.run();
    expect(mocks.guard).toHaveBeenCalledExactlyOnceWith(entry.role, {
      callbackPath: entry.callbackPath ?? entry.path,
    });
    for (const reader of READERS) {
      expect(reader).toHaveBeenCalledTimes(
        entry.readers.some((expectedReader) => expectedReader === reader) ? 1 : 0,
      );
    }
  });
});
