// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { ALLOWED_COMPETITION_TAGS } from "@/lib/competitions/tags";

const { mockPush, mockReplace, mockSessionFetch, requestLog } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockSessionFetch: vi.fn(),
  requestLog: [] as string[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => "/institution/institusi-contoh/competitions/new",
}));
vi.mock("@/lib/session/session-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session/session-fetch")>()),
  sessionFetch: mockSessionFetch,
}));

import { InstitutionCompetitionCreateShell } from "./institution-competition-create-shell";

const TAG = ALLOWED_COMPETITION_TAGS[0];
const CREATED = { id: "comp_new", slug: "lomba-baru-2026" };
const STEP_URL = "/institution/institusi-contoh/competitions/lomba-baru-2026/edit?langkah=";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const stubCreate = () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestLog.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse(201, { competition: CREATED });
    }),
  );
};

const answerTagsSave = (response: Response) => {
  mockSessionFetch.mockImplementation(
    async (_userId: string, input: string, init?: RequestInit) => {
      requestLog.push(`${init?.method ?? "GET"} ${input}`);
      return response;
    },
  );
};

const mountAndFill = () => {
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionCompetitionCreateShell
          institutionSlug="institusi-contoh"
          expectedUserId="user_recruiter"
        />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );
  fireEvent.change(screen.getByLabelText(/Judul/), { target: { value: "Lomba Baru 2026" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Kategori (wajib)" }));
  fireEvent.click(screen.getByRole("option", { name: "Hackathon" }));
  fireEvent.click(screen.getByRole("checkbox", { name: TAG }));
};

describe("InstitutionCompetitionCreateShell", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockSessionFetch.mockReset();
    requestLog.length = 0;
  });

  it("creates the draft, then saves its tags, then opens step 2 of the new draft", async () => {
    stubCreate();
    answerTagsSave(jsonResponse(200, { tags: [TAG] }));

    mountAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`${STEP_URL}2`));
    expect(requestLog).toEqual([
      "POST /api/v1/competitions",
      "PUT /api/v1/competitions/comp_new/tags",
    ]);
    expect(mockSessionFetch).toHaveBeenCalledWith(
      "user_recruiter",
      "/api/v1/competitions/comp_new/tags",
      expect.objectContaining({ method: "PUT" }),
    );
    const tagsBody = JSON.parse(mockSessionFetch.mock.lastCall?.[2]?.body as string);
    expect(tagsBody).toEqual({ tags: [TAG] });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens step 1 of the new draft with the tags error when the tags save fails", async () => {
    stubCreate();
    answerTagsSave(jsonResponse(400, { error: { code: "competition_tags_invalid_value" } }));

    mountAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`${STEP_URL}1`));
    expect(await screen.findByText("Pilih tag dari daftar yang tersedia.")).toBeTruthy();
    expect(requestLog).toEqual([
      "POST /api/v1/competitions",
      "PUT /api/v1/competitions/comp_new/tags",
    ]);
  });
});
