// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { InstitutionTeamShell } from "./institution-team-shell";

const MEMBERS_URL = "/api/v1/institutions/academy/members";
const INVITATIONS_URL = "/api/v1/institutions/academy/invitations";
const INVITATION_CANCEL_URL = `${INVITATIONS_URL}/inv_1/cancel`;
const STAFF_ROLE_URL = `${MEMBERS_URL}/mem_staff/role`;
const INVITED_EMAIL = "calon@contoh.id";

const MEMBERS = [
  {
    membershipId: "mem_owner",
    userId: "user_owner",
    name: "Rina Owner",
    email: "rina@contoh.id",
    role: "institution_owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    membershipId: "mem_staff",
    userId: "user_staff",
    name: "Dina Kusuma",
    email: "dina@contoh.id",
    role: "institution_staff",
    joinedAt: "2026-02-01T00:00:00.000Z",
  },
];

const INVITATIONS = [
  {
    id: "inv_1",
    invitedEmail: INVITED_EMAIL,
    invitedRole: "institution_staff",
    status: "pending",
    expiresAt: "2026-12-01T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
  },
];

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let cancelAnswer: () => Response;

const answerByUrlAndMethod = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = `${init?.method ?? "GET"} ${String(input)}`;
  if (request === `GET ${MEMBERS_URL}`) return jsonResponse(200, { members: MEMBERS });
  if (request === `GET ${INVITATIONS_URL}`) {
    return jsonResponse(200, { invitations: INVITATIONS });
  }
  if (request === `PATCH ${INVITATION_CANCEL_URL}`) return cancelAnswer();
  if (request === `PATCH ${STAFF_ROLE_URL}`) return jsonResponse(200, {});
  throw new Error(`unexpected request: ${request}`);
};

const fetchMock = vi.fn(answerByUrlAndMethod);

const writeRequests = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method !== undefined && init.method !== "GET");

const onlyWriteRequest = () => {
  const writes = writeRequests();
  expect(writes).toHaveLength(1);
  const [url, init] = writes[0]!;
  return { url: String(url), init };
};

const renderTeamPageAsOwner = async () => {
  render(
    <UIPrimitivesProvider>
      <InstitutionTeamShell institutionSlug="academy" actorUserId="user_owner" />
    </UIPrimitivesProvider>,
  );
  await screen.findByRole("button", { name: `Batalkan undangan untuk ${INVITED_EMAIL}` });
};

const pressInviteTrash = async () => {
  const trash = await screen.findByRole("button", {
    name: `Batalkan undangan untuk ${INVITED_EMAIL}`,
  });
  fireEvent.click(trash);
  return screen.findByRole("alertdialog");
};

beforeEach(() => {
  cancelAnswer = () => jsonResponse(200, {});
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cancelling a pending invite from the team page", () => {
  it("opens the pop-up titled with the invited email and sends no request", async () => {
    await renderTeamPageAsOwner();

    const dialog = await pressInviteTrash();

    const title = within(dialog).getByRole("heading");
    expect(title.textContent).toBe(`Batalkan undangan untuk ${INVITED_EMAIL}?`);
    expect(writeRequests()).toEqual([]);
  });

  it("closes the pop-up on Kembali and sends no request", async () => {
    await renderTeamPageAsOwner();
    const dialog = await pressInviteTrash();

    fireEvent.click(within(dialog).getByRole("button", { name: "Kembali" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writeRequests()).toEqual([]);
  });

  it("sends exactly one PATCH to the invitation cancel address on Batalkan undangan", async () => {
    await renderTeamPageAsOwner();
    const dialog = await pressInviteTrash();

    fireEvent.click(within(dialog).getByRole("button", { name: "Batalkan undangan" }));

    await waitFor(() => expect(writeRequests()).toHaveLength(1));
    const { url, init } = onlyWriteRequest();
    expect(url).toBe(INVITATION_CANCEL_URL);
    expect(init?.method).toBe("PATCH");
  });

  it("keeps the pop-up open and shows the failure message when the PATCH fails", async () => {
    cancelAnswer = () =>
      jsonResponse(409, { error: { code: "invitation_not_actionable", message: "x" } });
    await renderTeamPageAsOwner();
    const dialog = await pressInviteTrash();

    fireEvent.click(within(dialog).getByRole("button", { name: "Batalkan undangan" }));

    await waitFor(() =>
      expect(
        within(screen.getByRole("alertdialog")).getByText(
          "Undangan ini sudah tidak aktif, jadi tidak dapat dibatalkan.",
        ),
      ).toBeTruthy(),
    );
    expect(writeRequests()).toHaveLength(1);
  });
});

describe("changing a staff member's role from the team page", () => {
  it("sends exactly one PATCH to the member role address with institution_member", async () => {
    await renderTeamPageAsOwner();

    fireEvent.click(screen.getByRole("button", { name: "Ubah peran Dina Kusuma" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Jadikan anggota" }));

    await waitFor(() => expect(writeRequests()).toHaveLength(1));
    const { url, init } = onlyWriteRequest();
    expect(url).toBe(STAFF_ROLE_URL);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ role: "institution_member" });
  });
});
