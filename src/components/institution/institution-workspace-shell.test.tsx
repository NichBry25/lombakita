// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { PageTransitionProvider } from "@/components/ui/page-transition";
import { InstitutionWorkspaceShell } from "./institution-workspace-shell";

const { routerReplace } = vi.hoisted(() => ({ routerReplace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: routerReplace }),
  usePathname: () => "/institution/create",
}));

const NAME_LABEL = /^Nama institusi(?: \* \(wajib\)| \(opsional\))?$/;
const KIND_SELECT_NAME = "Jenis institusi (wajib)";
const KIND_HELP =
  "Pilih Pribadi jika Anda menyelenggarakan atas nama sendiri. Nama dan alamat institusi bisa diubah nanti di pengaturan.";
const USERNAME_CLASH_COPY =
  "Alamat institusi ini sama dengan username sebuah akun. Ubah nama institusi atau isi slug lain.";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchStub = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

// jsdom does no layout, so it has no scrollIntoView, and focusFirstInvalidField scrolls the field into view.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderForm = () =>
  render(
    <UIPrimitivesProvider>
      <PageTransitionProvider>
        <InstitutionWorkspaceShell expectedUserId="u1" />
      </PageTransitionProvider>
    </UIPrimitivesProvider>,
  );

const typeName = (name: string) => {
  fireEvent.change(screen.getByLabelText(NAME_LABEL), { target: { value: name } });
};

const pickKind = (label: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: KIND_SELECT_NAME }));
  fireEvent.click(screen.getByRole("option", { name: label }));
};

const pressCreate = () => {
  fireEvent.click(screen.getByRole("button", { name: "Buat institusi" }));
};

describe("the workspace create form", () => {
  it("offers the five kinds in order with none picked and refuses a submit with no kind", async () => {
    fetchStub.mockRejectedValue(new Error("no request expected"));
    renderForm();

    typeName("Ruang Uji");
    const combobox = screen.getByRole("combobox", { name: KIND_SELECT_NAME });
    fireEvent.click(combobox);

    expect(combobox.textContent).toBe("Pilih jenis institusi");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Pribadi",
      "Perusahaan",
      "Yayasan",
      "Universitas",
      "Organisasi kampus",
    ]);
    expect(options.some((option) => option.getAttribute("aria-selected") === "true")).toBe(false);

    fireEvent.keyDown(options[0]!, { key: "Escape" });
    pressCreate();

    expect(await screen.findByText("Pilih jenis institusi.")).toBeTruthy();
    expect(combobox.getAttribute("aria-invalid")).toBe("true");
    expect(combobox.getAttribute("aria-describedby")).toBe("institution-type-error");
    expect(screen.getByText(KIND_HELP)).toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts through the session guard with the expected user and opens the new workspace", async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(201, {
        institution: { slug: "ruang-uji", displayName: "Ruang Uji", institutionType: "personal" },
      }),
    );
    renderForm();

    typeName("Ruang Uji");
    pickKind("Pribadi");
    pressCreate();

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/institutions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Expected-User-Id")).toBe("u1");
    expect(init?.credentials).toBe("include");
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: "Ruang Uji",
      institutionType: "personal",
    });
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/institution/ruang-uji"));
  });

  it("shows the session-changed message when the create is refused for another account", async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(409, { error: { code: "session_user_mismatch", message: "x" } }),
    );
    renderForm();

    typeName("Ruang Uji");
    pickKind("Perusahaan");
    pressCreate();

    expect(
      await screen.findByText("Sesi telah berubah ke akun lain. Muat ulang halaman dan coba lagi."),
    ).toBeTruthy();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("tells a host whose trust staff removed that no new workspace can be made", async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(403, {
        error: { code: "institution_create_blocked_trust_removed", message: "x" },
      }),
    );
    renderForm();

    typeName("Ruang Uji");
    pickKind("Pribadi");
    pressCreate();

    expect(
      await screen.findByText(
        "Status tepercaya akun Anda dicabut staf, jadi Anda tidak dapat membuat institusi baru. Institusi yang sudah Anda kelola tetap ada. Hubungi staf Lombakita jika ada pertanyaan.",
      ),
    ).toBeTruthy();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("shows a username clash on the name field and clears it when the name changes", async () => {
    fetchStub.mockResolvedValue(
      jsonResponse(409, {
        error: { code: "institution_slug_conflicts_with_username", message: "x" },
      }),
    );
    renderForm();

    typeName("Ruang Uji");
    pickKind("Pribadi");
    pressCreate();

    expect(await screen.findByText(USERNAME_CLASH_COPY)).toBeTruthy();
    const nameInput = screen.getByLabelText(NAME_LABEL);
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(nameInput.getAttribute("aria-describedby")).toBe("institution-display-name-error");
    expect(routerReplace).not.toHaveBeenCalled();

    typeName("Ruang Uji Baru");

    expect(screen.queryByText(USERNAME_CLASH_COPY)).toBeNull();
    expect(nameInput.getAttribute("aria-invalid")).toBe("false");
  });
});
