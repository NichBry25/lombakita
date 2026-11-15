// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import {
  emptyProfileCollections,
  type ProfileCollections,
} from "@/server/user-profile/profile-collections-core";
import { ProfileCollectionsEditor } from "./profile-collections-editor";

const USER_ID = "user-1";

const collectionsWithOneExperience = (): ProfileCollections => ({
  ...emptyProfileCollections(),
  experiences: [
    {
      id: "exp-1",
      title: "Magang Analis",
      organizationName: "Lombakita",
      location: null,
      startDate: null,
      endDate: null,
      isCurrent: false,
      description: null,
    },
  ],
});

const renderEditor = () =>
  render(
    <UIPrimitivesProvider>
      <ProfileCollectionsEditor expectedUserId={USER_ID} initial={collectionsWithOneExperience()} />
    </UIPrimitivesProvider>,
  );

const findTrash = () => screen.queryByRole("button", { name: "Hapus pengalaman Magang Analis" });

const openDeleteConfirm = () => {
  fireEvent.click(screen.getByRole("button", { name: "Hapus pengalaman Magang Analis" }));
  return screen.getByRole("alertdialog");
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deleting a saved profile entry", () => {
  it("asks first, sends nothing until confirmed and keeps the entry until the server answers OK", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    const confirm = openDeleteConfirm();

    expect(within(confirm).getByText("Hapus pengalaman ini?")).toBeTruthy();
    expect(confirm.textContent).toContain("“Magang Analis” akan dihapus dari profil Anda.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findTrash()).not.toBeNull();

    fireEvent.click(within(confirm).getByRole("button", { name: "Hapus pengalaman" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/users/me/profile/experiences/exp-1");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("X-Expected-User-Id")).toBe(USER_ID);
    expect(findTrash()).not.toBeNull();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await act(async () => answer(new Response("{}", { status: 200 })));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(findTrash()).toBeNull();
  });

  it("keeps the entry and shows the failure inside the pop-up when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    renderEditor();

    const confirm = openDeleteConfirm();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Hapus pengalaman" }));
    });

    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert.textContent).toContain("Gagal menghapus entri. Coba lagi.");
    expect(findTrash()).not.toBeNull();
  });

  it("keeps the entry and shows the failure inside the pop-up when the request cannot be sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderEditor();

    const confirm = openDeleteConfirm();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Hapus pengalaman" }));
    });

    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert.textContent).toContain("Gagal terhubung ke server. Coba lagi.");
    expect(findTrash()).not.toBeNull();
  });
});
