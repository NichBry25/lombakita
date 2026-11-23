// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { mockAddToast, mockRefresh } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }) }));
vi.mock("@/components/ui/primitives", async (importActual) => {
  const actual = await importActual<typeof import("@/components/ui/primitives")>();
  return { ...actual, useToast: () => ({ addToast: mockAddToast }) };
});

import { ENTRANT_RESULT_MESSAGE, OWN_RESULT_MESSAGE } from "@/lib/errors/error-copy";
import { ResultForm } from "./result-form";

const refuseWith = (code: string) =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { code, message: "server text" } }), {
      status: 403,
    }),
  );

const renderForm = (initialStatus: "draft" | "published") =>
  render(
    <ResultForm
      apiBasePath="/api/v1/institutions/lk-univ/competitions/comp-1/registrations/reg-1/result"
      initialStatus={initialStatus}
      initialLabel="Juara 1"
      initialNotes={null}
      registrationType="individual"
      teamName={null}
      activeMemberCount={null}
    />,
  );

describe("ResultForm refusal of the actor's own entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    { action: "saving a draft", status: "draft" as const, button: "Simpan draf" },
    { action: "publishing", status: "draft" as const, button: "Terbitkan" },
    { action: "unpublishing", status: "published" as const, button: "Batalkan publikasi" },
  ])("shows OWN_RESULT_MESSAGE when $action is refused with result_own_place", async (scenario) => {
    vi.stubGlobal("fetch", refuseWith("result_own_place"));
    renderForm(scenario.status);

    fireEvent.click(screen.getByRole("button", { name: scenario.button }));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledTimes(1));
    expect(mockAddToast).toHaveBeenCalledWith({ type: "error", message: OWN_RESULT_MESSAGE });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("ResultForm refusal of an actor who holds an entry in the competition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    { action: "saving a draft", status: "draft" as const, button: "Simpan draf" },
    { action: "publishing", status: "draft" as const, button: "Terbitkan" },
    { action: "unpublishing", status: "published" as const, button: "Batalkan publikasi" },
  ])("shows ENTRANT_RESULT_MESSAGE when $action is refused", async (scenario) => {
    vi.stubGlobal("fetch", refuseWith("result_actor_is_entrant"));
    renderForm(scenario.status);

    fireEvent.click(screen.getByRole("button", { name: scenario.button }));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledTimes(1));
    expect(mockAddToast).toHaveBeenCalledWith({ type: "error", message: ENTRANT_RESULT_MESSAGE });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
