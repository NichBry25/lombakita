// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatWib } from "@/lib/dates/date-format";

const mocks = vi.hoisted(() => ({
  resolveEmailDelivery: vi.fn(),
  sendEmail: vi.fn(),
  serverEnv: { appEnv: "test" as string },
}));

vi.mock("@/config/env.server", () => ({ serverEnv: mocks.serverEnv }));
vi.mock("@/config/env", () => ({ publicEnv: { appUrl: "https://lombakita.test" } }));
vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/email/delivery", () => ({ resolveEmailDelivery: mocks.resolveEmailDelivery }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mocks.sendEmail },
  })),
}));

import { sendTeamInvitationEmail } from "./team-email";

const EXPIRES_AT = new Date("2026-12-15T16:59:00.000Z");
const REGISTERED_TEAM_LINE =
  "Tim ini sudah terdaftar. Jika Anda menerima undangan ini sebelum pendaftaran ditutup, Anda langsung terdaftar bersama tim.";

const sendInvitation = (joinsRegisteredTeam: boolean) =>
  sendTeamInvitationEmail({
    toEmail: "dewi@example.test",
    teamName: "Tim Uji",
    competitionTitle: "Lomba Uji",
    inviterDisplayName: "Budi",
    expiresAt: EXPIRES_AT,
    mode: "targeted",
    joinsRegisteredTeam,
  });

const sentMessage = () => mocks.sendEmail.mock.calls[0]![0] as { text: string; html: string };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEmailDelivery.mockReturnValue({ apiKey: "key", from: "noreply@lombakita.test" });
  mocks.sendEmail.mockResolvedValue({ data: { id: "email_1" }, error: null });
});

describe("the team invitation email", () => {
  it("names the registration close as the last day of an invite to a registered team", async () => {
    await sendInvitation(true);

    const { text, html } = sentMessage();
    const closeLine = `Undangan ini berlaku hingga pendaftaran ditutup pada ${formatWib(EXPIRES_AT, "longDateTime")} WIB.`;
    expect(text).toContain(REGISTERED_TEAM_LINE);
    expect(html).toContain(REGISTERED_TEAM_LINE);
    expect(text).toContain(closeLine);
    expect(html).toContain(closeLine);
  });

  it("keeps the seven-day wording for an invite to a forming team", async () => {
    await sendInvitation(false);

    const { text, html } = sentMessage();
    expect(text).toContain(`Undangan ini berlaku hingga ${formatWib(EXPIRES_AT, "longDate")}.`);
    expect(text).not.toContain("Tim ini sudah terdaftar");
    expect(html).not.toContain("Tim ini sudah terdaftar");
  });
});
