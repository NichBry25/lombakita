// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveEmailDelivery, sendEmailMock } = vi.hoisted(() => ({
  resolveEmailDelivery: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/email/delivery", () => ({ resolveEmailDelivery }));
vi.mock("@/server/auth/email-verification", () => ({
  resolveBaseUrl: () => "https://lombakita.test",
}));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendEmailMock },
  })),
}));

import { formatWib } from "@/lib/dates/date-format";
import { logger } from "@/lib/logger";
import { EmailSendError } from "@/server/email/send-failure";
import {
  buildTeamCancelledBelowMinimumNotice,
  buildTeamJoinReminderNotice,
  sendTeamCloseNoticeEmail,
} from "./team-close-notices";

const DELIVERY = { apiKey: "key", from: "noreply@lombakita.test" };

const closesAt = new Date("2026-12-15T16:59:00.000Z");
const closeText = formatWib(closesAt, "longDateTime");

const shortTeamWithTwoPendingInvitesNotice = () =>
  buildTeamJoinReminderNotice({
    competitionTitle: "Lomba Uji",
    closesAt,
    pendingInviteeEmails: ["sari@example.test", "dewi@example.test"],
    shortfall: { missingMemberCount: 2, minTeamSize: 4 },
  });

const fullTeamWithPendingInviteNotice = () =>
  buildTeamJoinReminderNotice({
    competitionTitle: "Lomba Uji",
    closesAt,
    pendingInviteeEmails: ["sari@example.test"],
    shortfall: null,
  });

const shortTeamWithNoInviteNotice = () =>
  buildTeamJoinReminderNotice({
    competitionTitle: "Lomba Uji",
    closesAt,
    pendingInviteeEmails: [],
    shortfall: { missingMemberCount: 1, minTeamSize: 3 },
  });

const cancelledBelowMinimumNotice = () =>
  buildTeamCancelledBelowMinimumNotice({
    competitionTitle: "Lomba Uji",
    memberCount: 2,
    minTeamSize: 3,
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolveEmailDelivery.mockReturnValue(DELIVERY);
  sendEmailMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
});

describe("the captain's reminder", () => {
  it("names the pending teammates, the missing members and the close in a short team's reminder", () => {
    const notice = shortTeamWithTwoPendingInvitesNotice();

    expect(notice.title).toBe("Pendaftaran Lomba Uji ditutup dalam 24 jam");
    expect(notice.body).toBe(
      [
        `Pendaftaran ditutup pada ${closeText} WIB.`,
        "Undangan untuk sari@example.test, dewi@example.test belum diterima.",
        "Tim Anda masih membutuhkan 2 anggota lagi untuk mencapai jumlah minimal 4 anggota.",
        "Jika sampai saat itu jumlah anggota masih kurang, pendaftaran tim dibatalkan secara otomatis.",
        "Anda masih dapat membatalkan undangan dan mengundang orang lain sebelum pendaftaran ditutup.",
      ].join(" "),
    );
  });

  it("says an unanswered invite can no longer be accepted after the close when the team is not short", () => {
    const notice = fullTeamWithPendingInviteNotice();

    expect(notice.title).toBe("Pendaftaran Lomba Uji ditutup dalam 24 jam");
    expect(notice.body).toBe(
      [
        `Pendaftaran ditutup pada ${closeText} WIB.`,
        "Undangan untuk sari@example.test belum diterima.",
        "Undangan yang belum diterima sampai saat itu tidak dapat diterima lagi.",
        "Anda masih dapat membatalkan undangan dan mengundang orang lain sebelum pendaftaran ditutup.",
      ].join(" "),
    );
  });

  it("asks a short team with no pending invite to invite new members", () => {
    const notice = shortTeamWithNoInviteNotice();

    expect(notice.body).toBe(
      [
        `Pendaftaran ditutup pada ${closeText} WIB.`,
        "Tim Anda masih membutuhkan 1 anggota lagi untuk mencapai jumlah minimal 3 anggota.",
        "Jika sampai saat itu jumlah anggota masih kurang, pendaftaran tim dibatalkan secara otomatis.",
        "Anda masih dapat mengundang anggota baru sebelum pendaftaran ditutup.",
      ].join(" "),
    );
  });
});

describe("the notice to a member of a cancelled team", () => {
  it("says why the team's registration was cancelled and that nobody chose it", () => {
    const notice = cancelledBelowMinimumNotice();

    expect(notice.title).toBe("Pendaftaran tim dibatalkan otomatis untuk Lomba Uji");
    expect(notice.body).toBe(
      [
        "Saat pendaftaran ditutup, tim Anda baru memiliki 2 anggota, kurang dari jumlah minimal 3 anggota.",
        "Karena itu pendaftaran tim dibatalkan secara otomatis.",
        "Tim Anda tetap ada bersama anggota yang sudah bergabung.",
        "Pembatalan ini tidak dilakukan oleh penyelenggara dan bukan atas permintaan Anda.",
      ].join(" "),
    );
  });
});

describe("every notice", () => {
  it("uses no dash and no semicolon in any notice", () => {
    const notices = [
      shortTeamWithTwoPendingInvitesNotice(),
      fullTeamWithPendingInviteNotice(),
      shortTeamWithNoInviteNotice(),
      cancelledBelowMinimumNotice(),
    ];

    for (const notice of notices) {
      for (const text of [notice.title, notice.body]) {
        expect(text).not.toContain("—");
        expect(text).not.toContain("–");
        expect(text).not.toContain(";");
      }
    }
  });
});

describe("sendTeamCloseNoticeEmail", () => {
  const sendTheFirstNotice = () =>
    sendTeamCloseNoticeEmail({
      kind: "team_join_reminder",
      toEmail: "kapten@example.test",
      recipientId: "user-1",
      notice: shortTeamWithTwoPendingInvitesNotice(),
      teamPagePath: "/competitions/inst-uji/lomba-uji/registration",
    });

  it("sends a notice with its title as the subject and a link to the team page", async () => {
    const notice = shortTeamWithTwoPendingInvitesNotice();

    await sendTheFirstNotice();

    expect(resolveEmailDelivery).toHaveBeenCalledWith({
      kind: "team_join_reminder",
      to: "kapten@example.test",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith({
      from: "noreply@lombakita.test",
      to: "kapten@example.test",
      subject: notice.title,
      text: `${notice.body}\n\nBuka tim Anda di https://lombakita.test/competitions/inst-uji/lomba-uji/registration.`,
    });
    expect(logger.info).toHaveBeenCalledWith("notification.sent", {
      event: "team_join_reminder",
      recipientId: "user-1",
    });
  });

  it("sends nothing when delivery is suppressed", async () => {
    resolveEmailDelivery.mockReturnValueOnce(null);

    await sendTheFirstNotice();

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("rethrows a send the provider refuses, so the job is retried", async () => {
    sendEmailMock.mockResolvedValueOnce({
      data: null,
      error: { message: "rate limited", statusCode: 429, name: "rate_limit_exceeded" },
    });

    await expect(sendTheFirstNotice()).rejects.toBeInstanceOf(EmailSendError);
  });
});
