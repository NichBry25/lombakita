// @vitest-environment jsdom

// The staff institutions page, rendered inside the real UIPrimitivesProvider so the pop-ups and the
// toasts are the real ones. fetch is the only stub: the list route and the identity route answer in
// the shapes their route tests pin.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { VERIFICATION_REFUSAL_COPY } from "@/lib/institutions/verification-refusal-copy";
import AdminInstitutionsPage from "./page";

const LIST_URL = "/api/admin/institutions?page=1";
const IDENTITY_URL = "/api/platform-ops/institutions/inst_1/identity";

type TickPath = "domain" | "instagram" | "documents" | "staff" | null;

const rowFixture = (overrides: { id?: string; slug?: string; tickPath?: TickPath } = {}) => ({
  id: "inst_1",
  displayName: "Komunitas Lama",
  slug: "komunitas-lama",
  verificationStatus: "verified",
  tickPath: null as TickPath,
  verifiedAt: "2026-11-01T03:00:00.000Z",
  rejectedAt: null,
  rejectionReason: null,
  createdAt: "2026-10-01T03:00:00.000Z",
  adminEmail: "rina@acme.example",
  ...overrides,
});

type SentRequest = { url: string; method: string; body: unknown };

const sent: SentRequest[] = [];
let rows: ReturnType<typeof rowFixture>[] = [];
let answerIdentity: () => Response | Promise<Response> = () => jsonResponse({});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const refusal = (code: string, status: number) =>
  jsonResponse({ error: { code, message: "server text" } }, status);

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const rawBody = typeof init?.body === "string" ? init.body : null;
  sent.push({
    url,
    method: init?.method ?? "GET",
    body: rawBody === null ? null : JSON.parse(rawBody),
  });
  if (url === LIST_URL) {
    return jsonResponse({ institutions: rows, total: rows.length, page: 1 });
  }
  return answerIdentity();
});

vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  rows = [];
  answerIdentity = () => jsonResponse({});
});

// jsdom does no layout, so it has no scrollIntoView, and focusFirstInvalidField scrolls the field into view.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const showPage = async (items: ReturnType<typeof rowFixture>[]) => {
  rows = items;
  render(
    <UIPrimitivesProvider>
      <AdminInstitutionsPage />
    </UIPrimitivesProvider>,
  );
  await screen.findByRole("columnheader", { name: "Jalur centang" });
};

const listReads = (): SentRequest[] => sent.filter((request) => request.url === LIST_URL);

const identityRequests = (): SentRequest[] =>
  sent.filter((request) => request.url === IDENTITY_URL);

const openRenameDialog = (): HTMLElement => {
  fireEvent.click(screen.getByRole("button", { name: "Ubah nama" }));
  return screen.getByRole("dialog", { name: "Ubah nama" });
};

const fieldOf = (dialog: HTMLElement, label: RegExp) =>
  within(dialog).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;

const typeInto = (dialog: HTMLElement, label: RegExp, value: string) => {
  fireEvent.change(fieldOf(dialog, label), { target: { value } });
};

const failureOf = (dialog: HTMLElement): string | null | undefined =>
  dialog.querySelector(".modal-failure")?.textContent;

describe("the tick path column", () => {
  it("shows how each workspace won its tick", async () => {
    await showPage([
      rowFixture({ id: "inst_1", tickPath: "domain" }),
      rowFixture({ id: "inst_2", tickPath: "instagram" }),
      rowFixture({ id: "inst_3", tickPath: "documents" }),
      rowFixture({ id: "inst_4", tickPath: "staff" }),
      rowFixture({ id: "inst_5", tickPath: null }),
    ]);

    const cells = Array.from(document.querySelectorAll('td[data-label="Jalur centang"]'));
    expect(cells).toHaveLength(5);
    expect(cells.slice(0, 4).map((cell) => cell.textContent)).toEqual([
      "Email organisasi",
      "Instagram",
      "Dokumen",
      "Keputusan staf",
    ]);
    expect(cells[4]?.getAttribute("data-empty")).toBe("true");
  });
});

describe("the rename dialog", () => {
  it("renames a workspace through the identity route with the reason", async () => {
    await showPage([rowFixture()]);
    answerIdentity = () =>
      jsonResponse({
        institution: {
          institutionId: "inst_1",
          displayName: "Komunitas Baru",
          slug: "komunitas-baru",
        },
      });

    const dialog = openRenameDialog();
    expect(fieldOf(dialog, /^Nama\b/).value).toBe("Komunitas Lama");
    expect(fieldOf(dialog, /^Alamat/).value).toBe("komunitas-lama");
    typeInto(dialog, /^Nama\b/, "Komunitas Baru");
    typeInto(dialog, /^Alamat/, "komunitas-baru");
    typeInto(dialog, /^Alasan/, "  Nama resmi dari akta.  ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => {
      expect(identityRequests()).toEqual([
        {
          url: IDENTITY_URL,
          method: "PATCH",
          body: {
            displayName: "Komunitas Baru",
            slug: "komunitas-baru",
            reason: "Nama resmi dari akta.",
          },
        },
      ]);
    });
    await waitFor(() => {
      const toast = screen.getByText("Perubahan disimpan.").closest("[data-toast-type]");
      expect(toast?.getAttribute("data-toast-type")).toBe("success");
    });
    await waitFor(() => {
      expect(listReads()).toHaveLength(2);
    });
  });

  it("asks for a reason before renaming and shows each refusal of the identity route", async () => {
    await showPage([rowFixture()]);
    const dialog = openRenameDialog();

    typeInto(dialog, /^Alasan/, "   ");
    fireEvent.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByText("Alasan wajib diisi.")).toBeTruthy();
    expect(fieldOf(dialog, /^Alasan/).getAttribute("aria-invalid")).toBe("true");
    expect(identityRequests()).toEqual([]);

    typeInto(dialog, /^Alasan/, "Nama resmi dari akta.");
    const answers: [Response, string][] = [
      [refusal("institution_rename_reason_required", 400), "Alasan wajib diisi."],
      [refusal("institution_invalid_value", 400), "Periksa nama dan alamat lalu coba lagi."],
      [
        refusal("institution_slug_reserved", 422),
        "Alamat ini tidak dapat digunakan. Pilih alamat lain.",
      ],
      [
        refusal("institution_display_name_reserved", 422),
        "Nama ini tidak dapat digunakan. Pilih nama lain.",
      ],
      [
        refusal("institution_slug_conflicts_with_username", 409),
        "Alamat ini sudah dipakai sebagai username. Pilih alamat lain.",
      ],
      [
        refusal("operator_actor_conflicted", 403),
        "Anda tidak dapat mengambil tindakan atas institusi ini karena akun Anda pernah mengajukan verifikasi, diundang, atau menjadi anggota institusi tersebut.",
      ],
      [
        refusal("verification_transition_conflict", 409),
        VERIFICATION_REFUSAL_COPY.verification_transition_conflict ?? "",
      ],
      [refusal("unknown_code", 500), "Nama gagal diubah. Coba lagi."],
    ];
    for (const [answer, text] of answers) {
      answerIdentity = () => answer.clone();
      fireEvent.click(within(dialog).getByRole("button", { name: "Simpan" }));
      await waitFor(() => {
        expect(failureOf(dialog)).toBe(text);
      });
    }

    answerIdentity = () => {
      throw new Error("offline");
    };
    fireEvent.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() => {
      expect(failureOf(dialog)).toBe(NETWORK_ERROR_MESSAGE);
    });
    expect(listReads()).toHaveLength(1);
  });
});
