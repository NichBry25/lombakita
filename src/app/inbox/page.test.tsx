// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatWib } from "@/lib/dates/date-format";
import type { InboxItem } from "@/server/notifications/inbox-service";

const { mockGetCurrentSession, mockListUserInbox, mockCountUnreadInboxItems, mockRedirect } =
  vi.hoisted(() => ({
    mockGetCurrentSession: vi.fn(),
    mockListUserInbox: vi.fn(),
    mockCountUnreadInboxItems: vi.fn(),
    mockRedirect: vi.fn(),
  }));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/server/auth/session", () => ({ getCurrentSession: mockGetCurrentSession }));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/server/notifications/inbox-service", () => ({
  listUserInbox: mockListUserInbox,
  countUnreadInboxItems: mockCountUnreadInboxItems,
}));
vi.mock("./invite-actions", () => ({ InboxInviteActions: () => null }));
vi.mock("./mark-read-button", () => ({ MarkReadButton: () => null }));
vi.mock("./delete-notification-button", () => ({ DeleteNotificationButton: () => null }));

import InboxPage from "@/app/inbox/page";

const CLOSE = new Date("2026-11-30T16:59:00.000Z");

const renderInboxWith = async (items: InboxItem[]): Promise<string> => {
  mockListUserInbox.mockResolvedValue(items);
  return renderToStaticMarkup(await InboxPage());
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentSession.mockResolvedValue({
    user: { id: "u_candidate", role: "candidate" },
    expires: new Date(Date.now() + 60_000).toISOString(),
  });
  mockCountUnreadInboxItems.mockResolvedValue(0);
});

describe("the inbox page", () => {
  it("says a team invite is open until registration closes, with the close", async () => {
    const markup = await renderInboxWith([
      {
        kind: "team_invite",
        id: "inv_1",
        teamName: "Tim Uji",
        competitionTitle: "Lomba Uji",
        expiresAt: CLOSE,
        createdAt: CLOSE,
      },
    ]);

    expect({
      saysOpenUntilClose: markup.includes("Berlaku hingga pendaftaran ditutup pada"),
      showsClose: markup.includes(formatWib(CLOSE, "longDateTime")),
      saysExpiry: markup.includes("Kedaluwarsa"),
    }).toEqual({ saysOpenUntilClose: true, showsClose: true, saysExpiry: false });
  });

  it("keeps the expiry line on an institution invite", async () => {
    const markup = await renderInboxWith([
      {
        kind: "institution_invite",
        id: "inv_2",
        institutionName: "Institusi Uji",
        invitedRole: "institution_staff",
        expiresAt: CLOSE,
        createdAt: CLOSE,
      },
    ]);

    expect({
      saysExpiry: markup.includes("Kedaluwarsa:"),
      saysOpenUntilClose: markup.includes("Berlaku hingga pendaftaran ditutup"),
    }).toEqual({ saysExpiry: true, saysOpenUntilClose: false });
  });
});
