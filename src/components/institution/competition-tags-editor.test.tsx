// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { ALLOWED_COMPETITION_TAGS } from "@/lib/competitions/tags";
import { CompetitionTagsEditor } from "./competition-tags-editor";

const [FIRST_TAG, SECOND_TAG] = ALLOWED_COMPETITION_TAGS;

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe("CompetitionTagsEditor", () => {
  it("in controlled mode reports each toggle through onChange and sends no request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onChange = vi.fn();

    render(
      <UIPrimitivesProvider>
        <CompetitionTagsEditor value={[FIRST_TAG]} onChange={onChange} />
      </UIPrimitivesProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: SECOND_TAG }));
    expect(onChange).toHaveBeenLastCalledWith([FIRST_TAG, SECOND_TAG]);

    fireEvent.click(screen.getByRole("checkbox", { name: FIRST_TAG }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    expect(screen.queryByRole("button", { name: "Simpan" })).toBeNull();
    expect(screen.queryByText("Memuat tag…")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with a competitionId loads the stored tags and saves the selection", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      if (init?.method === "PUT") return okJson({ tags: [FIRST_TAG, SECOND_TAG] });
      return okJson({ tags: [FIRST_TAG] });
    });
    vi.stubGlobal("fetch", fetchSpy);

    render(
      <UIPrimitivesProvider>
        <CompetitionTagsEditor competitionId="comp_1" expectedUserId="org_1" />
      </UIPrimitivesProvider>,
    );

    const firstTag = await screen.findByRole("checkbox", { name: FIRST_TAG });
    expect((firstTag as HTMLInputElement).checked).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/competitions/comp_1/tags",
      expect.objectContaining({ cache: "no-store" }),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: SECOND_TAG }));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));

    expect(await screen.findByText("Tag berhasil disimpan.")).toBeTruthy();
    const putCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall?.[0]).toBe("/api/v1/competitions/comp_1/tags");
    const headers = new Headers(putCall?.[1]?.headers);
    expect(headers.get("X-Expected-User-Id")).toBe("org_1");
    expect(JSON.parse(putCall?.[1]?.body as string)).toEqual({ tags: [FIRST_TAG, SECOND_TAG] });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });
});
