// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { InboxInviteActions } from "./invite-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the inbox actions of a team invitation", () => {
  it("says registration has closed when a team invite is accepted after the close", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "team_competition_registration_closed" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <UIPrimitivesProvider>
        <InboxInviteActions kind="team" invitationId="inv-1" expectedUserId="user-1" />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terima" }));
    await screen.findByText("Terima undangan?");
    const confirmButtons = screen.getAllByRole("button", { name: "Terima" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(
      await screen.findByText(
        "Pendaftaran kompetisi ini sudah ditutup, jadi undangan tim ini tidak dapat diterima lagi.",
      ),
    ).toBeTruthy();
    const [requestedUrl] = fetchMock.mock.calls[0] as unknown[];
    expect(requestedUrl).toBe("/api/v1/me/invitations/team/inv-1/accept");
  });

  it("says why an owner or staff member of the competition's institution cannot accept a team invite", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "team_host_of_competition" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    render(
      <UIPrimitivesProvider>
        <InboxInviteActions kind="team" invitationId="inv-1" expectedUserId="user-1" />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terima" }));
    await screen.findByText("Terima undangan?");
    const confirmButtons = screen.getAllByRole("button", { name: "Terima" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(
      await screen.findByText(
        "Anda pemilik atau staf penyelenggara kompetisi ini, jadi tidak dapat ikut mendaftar.",
      ),
    ).toBeTruthy();
  });
});

describe("the inbox actions of an institution invitation", () => {
  it("says an owner or staff invitation from a host whose trust staff removed cannot be taken", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "invitation_inviter_trust_removed" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <UIPrimitivesProvider>
        <InboxInviteActions kind="institution" invitationId="inv-1" expectedUserId="user-1" />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terima" }));
    await screen.findByText("Terima undangan?");
    const confirmButtons = screen.getAllByRole("button", { name: "Terima" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    expect(
      await screen.findByText(
        "Status tepercaya akun pengundang dicabut staf Lombakita, jadi undangan sebagai pemilik atau staf ini tidak dapat diterima. Minta pemilik atau staf lain di ruang kerja itu mengirim undangan baru, atau hubungi staf Lombakita.",
      ),
    ).toBeTruthy();
    const [requestedUrl] = fetchMock.mock.calls[0] as unknown[];
    expect(requestedUrl).toBe("/api/v1/me/invitations/institution/inv-1/accept");
  });
});
