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

  it("names the registration close as the last day of an invite to a forming team too", async () => {
    await sendInvitation(false);

    const { text, html } = sentMessage();
    const closeLine = `Undangan ini berlaku hingga pendaftaran ditutup pada ${formatWib(EXPIRES_AT, "longDateTime")} WIB.`;
    expect({
      textHasClose: text.includes(closeLine),
      htmlHasClose: html.includes(closeLine),
      textSaysRegistered: text.includes("Tim ini sudah terdaftar"),
      htmlSaysRegistered: html.includes("Tim ini sudah terdaftar"),
    }).toEqual({
      textHasClose: true,
      htmlHasClose: true,
      textSaysRegistered: false,
      htmlSaysRegistered: false,
    });
  });

  it("escapes the team name, the competition title and the inviter's name in the html", async () => {
    await sendTeamInvitationEmail({
      toEmail: "dewi@example.test",
      teamName: `Tim <a href="https://contoh.test">Klik</a>`,
      competitionTitle: "Lomba <b>Uji</b>",
      inviterDisplayName: "Budi <i>Kapten</i>",
      expiresAt: EXPIRES_AT,
      mode: "targeted",
      joinsRegisteredTeam: false,
    });

    const { html } = sentMessage();
    expect(html).toContain("Tim &lt;a href=&quot;https://contoh.test&quot;&gt;Klik&lt;/a&gt;");
    expect(html).toContain("Lomba &lt;b&gt;Uji&lt;/b&gt;");
    expect(html).toContain("Budi &lt;i&gt;Kapten&lt;/i&gt;");
    expect(html).not.toContain(`<a href="https://contoh.test">`);
  });
});
