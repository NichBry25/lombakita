// @vitest-environment jsdom
//
// THE TWO USER-PANEL ACTIONS THAT WRITE, AND WHAT THE OPERATOR IS TOLD BEFORE THEY DO.
//
// Both actions are destructive and neither is undoable through this console: one raises an account's
// recruiter tier, the other de-identifies the account permanently. What the operator sees before
// confirming is the whole of their protection, so the confirmation text and the refusal text are
// asserted here word for word rather than matched loosely.
//
// The refusals are a TABLE, one row per code the route can answer with, because the failure this
// file exists to catch is a single map entry going missing: the console would then print
// `deidentify_last_owner: <server prose>` — the raw code — at an operator who has no idea what it
// means, and nothing else in the repo would notice.
//
// PROVIDERS, NOT HOOK MOCKS. `src/components/finance/organiser-payment-queue.test.tsx` renders a
// component that calls `useModal` and `useToast` inside the real `UIPrimitivesProvider`, and its
// header says why it mocks nothing but the router. That is the same choice here and the same reason:
// the modal's title, body and confirm label are what this file asserts, and a stubbed `useModal`
// would leave those assertions measuring the stub.

import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { ModerationConsole } from "./moderation-console";

type ConsoleUser = {
  id: string;
  email: string;
  name: string | null;
  username: string;
  appRole: string;
  status: string;
  recruiterVerificationTier: string;
  candidateVerifiedAt: string | null;
  recruiterVerifiedAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
};

const userFixture = (overrides: Partial<ConsoleUser> = {}): ConsoleUser => ({
  id: "user_target",
  email: "target@example.test",
  name: "Bela Rahma",
  username: "bela_rahma",
  appRole: "recruiter",
  status: "active",
  recruiterVerificationTier: "verified",
  candidateVerifiedAt: null,
  recruiterVerifiedAt: null,
  suspendedAt: null,
  suspensionReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

type SentRequest = { url: string; method: string; body: unknown };

const sent: SentRequest[] = [];
let lookedUpUser: ConsoleUser = userFixture();
let actionResponse: () => Response = () => jsonResponse({});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const rawBody = typeof init?.body === "string" ? init.body : null;

  sent.push({
    url,
    method: init?.method ?? "GET",
    body: rawBody === null ? null : JSON.parse(rawBody),
  });

  if (url.startsWith("/api/platform-ops/users/lookup")) {
    return jsonResponse({ user: lookedUpUser });
  }

  if (url.startsWith("/api/platform-ops/notes")) {
    return jsonResponse({ notes: [] });
  }

  return actionResponse();
});

vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  lookedUpUser = userFixture();
  actionResponse = () => jsonResponse({});
});

const userPanel = (): HTMLElement =>
  screen.getByRole("heading", { name: "Pengguna" }).closest("section") as HTMLElement;

const lookUp = async (user: ConsoleUser) => {
  lookedUpUser = user;

  render(
    <UIPrimitivesProvider>
      <ModerationConsole />
    </UIPrimitivesProvider>,
  );

  const panel = within(userPanel());
  fireEvent.change(panel.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.click(panel.getByRole("button", { name: "Cari" }));

  // The name renders as the `<strong>` of the result block, so it is the one text node that proves
  // the lookup resolved and the panel switched from the form to the account.
  await screen.findByText(user.name as string);
};

const toastOf = (text: string): Element | null =>
  screen.getByText(text).closest("[data-toast-type]");

const requestTo = (url: string): SentRequest | undefined => sent.find((r) => r.url === url);

// Filling the two fields the de-identification action requires. The values are the ones the fixture
// holds, so a body assertion below reads as "what the operator typed" rather than as a constant.
const fillDeidentifyForm = () => {
  fireEvent.change(screen.getByLabelText("Ketik nama pengguna akun untuk konfirmasi"), {
    target: { value: "bela_rahma" },
  });
  fireEvent.change(
    screen.getByLabelText("Alasan (contoh: permintaan melalui email tanggal 28 September 2026)"),
    { target: { value: "permintaan pemilik" } },
  );
};

const confirmDeidentify = async () => {
  fillDeidentifyForm();
  fireEvent.click(screen.getByRole("button", { name: "Hapus data akun" }));
  fireEvent.click(screen.getByRole("button", { name: "Hapus data" }));

  await waitFor(() => {
    expect(requestTo("/api/platform-ops/accounts/user_target/deidentify")).toBeDefined();
  });
};

describe("what the user panel offers", () => {
  it("offers both actions on a recruiter below the target tier", async () => {
    // The positive. Every absence asserted below is worthless without it, since they would all pass
    // against a panel that rendered no actions at all.
    await lookUp(userFixture({ recruiterVerificationTier: "verified" }));

    expect(screen.getByRole("button", { name: "Naikkan ke tingkat penuh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus data akun" })).toBeTruthy();
  });

  it("offers no de-identification on an internal ops account", async () => {
    await lookUp(userFixture({ appRole: "platform_ops" }));

    expect(screen.queryByRole("button", { name: "Hapus data akun" })).toBeNull();
  });

  it("offers no de-identification on an account that was already de-identified", async () => {
    await lookUp(userFixture({ status: "deactivated" }));

    expect(screen.queryByRole("button", { name: "Hapus data akun" })).toBeNull();
  });
});

describe("elevating a recruiter to the full tier", () => {
  it("names the consequence, then sends the elevation", async () => {
    await lookUp(userFixture({ recruiterVerificationTier: "verified" }));
    actionResponse = () => jsonResponse({ changed: true });

    fireEvent.click(screen.getByRole("button", { name: "Naikkan ke tingkat penuh" }));

    expect(screen.getByText("Naikkan tingkat rekruter?")).toBeTruthy();
    expect(
      screen.getByText("Akun ini akan dapat membuat institusi dan menerbitkan kompetisi."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Naikkan" }));

    await waitFor(() => {
      expect(screen.getByText("Tingkat rekruter dinaikkan.")).toBeTruthy();
    });

    const request = requestTo("/api/platform-ops/accounts/user_target/recruiter-tier");

    expect(request?.method).toBe("PATCH");
    expect(request?.body).toEqual({ tier: "elevated" });
    expect(toastOf("Tingkat rekruter dinaikkan.")?.getAttribute("data-toast-type")).toBe("success");
  });

  it("tells the operator an account that was already at the tier was left alone", async () => {
    await lookUp(userFixture({ recruiterVerificationTier: "verified" }));
    actionResponse = () => jsonResponse({ changed: false });

    fireEvent.click(screen.getByRole("button", { name: "Naikkan ke tingkat penuh" }));
    fireEvent.click(screen.getByRole("button", { name: "Naikkan" }));

    await waitFor(() => {
      expect(screen.getByText("Akun ini sudah di tingkat penuh.")).toBeTruthy();
    });
  });
});

describe("de-identifying an account", () => {
  it("asks for the username and the reason before it offers the confirmation", async () => {
    await lookUp(userFixture());

    expect(screen.getByLabelText("Ketik nama pengguna akun untuk konfirmasi")).toBeTruthy();
    expect(
      screen.getByLabelText("Alasan (contoh: permintaan melalui email tanggal 28 September 2026)"),
    ).toBeTruthy();
  });

  it("carries the consequence, the typed confirmation and the reason into the request", async () => {
    await lookUp(userFixture());
    actionResponse = () => jsonResponse({ objectsDeleted: 7 });

    fireEvent.change(screen.getByLabelText("Ketik nama pengguna akun untuk konfirmasi"), {
      target: { value: "bela_rahma" },
    });
    fireEvent.change(
      screen.getByLabelText("Alasan (contoh: permintaan melalui email tanggal 28 September 2026)"),
      { target: { value: "permintaan pemilik" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Hapus data akun" }));

    expect(screen.getByText("Hapus data akun ini?")).toBeTruthy();
    expect(
      screen.getByText(
        "Nama, email, profil, dan berkas akun ini akan dihapus permanen, dan akun tidak dapat masuk lagi. Catatan pendaftaran, hasil lomba, keuangan, dan audit tetap disimpan tanpa data pribadi. Tindakan ini tidak dapat dibatalkan.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hapus data" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hapus data" }));

    await waitFor(() => {
      expect(screen.getByText("Data akun dihapus. 7 berkas dihapus.")).toBeTruthy();
    });

    const request = requestTo("/api/platform-ops/accounts/user_target/deidentify");

    expect(request?.method).toBe("POST");
    expect(request?.body).toEqual({ confirmUsername: "bela_rahma", reason: "permintaan pemilik" });
    expect(toastOf("Data akun dihapus. 7 berkas dihapus.")?.getAttribute("data-toast-type")).toBe(
      "success",
    );
  });
});

// THE REFUSAL TABLE.
//
// `message` is the server's own prose packed into the error envelope. It is deliberately NOT equal to
// the expected toast on the eight codes that have fixed copy: a row that sent the sentence it then
// asserts would pass against a console that echoed whatever arrived, which is the behaviour the map
// exists to replace. The two institution codes are the exception and are marked as such — their copy
// carries slugs only the server knows, so its message IS the toast.
const DEIDENTIFY_REFUSALS: {
  code: string;
  status: number;
  message: string;
  toast: string;
  fromServerMessage?: true;
}[] = [
  {
    code: "deidentify_reason_required",
    status: 400,
    message: "reason must not be empty",
    toast: "Alasan wajib diisi.",
  },
  {
    code: "deidentify_confirmation_mismatch",
    status: 400,
    message: "typed confirmation does not match",
    toast: "Nama pengguna konfirmasi tidak cocok.",
  },
  {
    code: "deidentify_account_not_found",
    status: 404,
    message: "Account not found",
    toast: "deidentify_account_not_found: Account not found",
  },
  {
    code: "deidentify_invalid_payload",
    status: 400,
    message: "Request body must be valid JSON",
    toast: "deidentify_invalid_payload: Request body must be valid JSON",
  },
  {
    code: "deidentify_target_is_operator",
    status: 403,
    message: "target holds platform_ops",
    toast: "Akun operator tidak dapat dihapus lewat tindakan ini.",
  },
  {
    code: "operator_actor_is_target",
    status: 403,
    message: "the acting account is the target",
    toast: "Anda tidak dapat menghapus akun Anda sendiri.",
  },
  {
    code: "deidentify_already_done",
    status: 409,
    message: "no objects remain",
    toast: "Data akun ini sudah dihapus sebelumnya.",
  },
  {
    code: "deidentify_storage_unavailable",
    status: 503,
    message: "R2 is not configured",
    toast: "Penyimpanan berkas tidak tersedia. Coba lagi nanti.",
  },
  {
    code: "deidentify_storage_failed",
    status: 502,
    message: "delete threw after 3 objects",
    toast: "Sebagian berkas gagal dihapus. Jalankan lagi untuk menyelesaikan.",
  },
  {
    code: "deidentify_rehearsal_failed",
    status: 500,
    message: "23505 on users_username_unique",
    toast: "Penghapusan tidak dapat diproses. Tidak ada data yang diubah. Laporkan ke tim teknis.",
  },
  {
    code: "deidentify_last_owner",
    status: 409,
    message:
      "Akun ini pemilik terakhir institusi: seed-academy, lk-univ. Pindahkan kepemilikan terlebih dahulu.",
    toast:
      "Akun ini pemilik terakhir institusi: seed-academy, lk-univ. Pindahkan kepemilikan terlebih dahulu.",
    fromServerMessage: true,
  },
  {
    code: "deidentify_personal_institution_has_published_competition",
    status: 409,
    message:
      "Institusi pribadi akun ini masih punya kompetisi terbit: expo-2026. Arsipkan atau batalkan dulu.",
    toast:
      "Institusi pribadi akun ini masih punya kompetisi terbit: expo-2026. Arsipkan atau batalkan dulu.",
    fromServerMessage: true,
  },
];

describe("what the console tells the operator when the server refuses", () => {
  it.each(DEIDENTIFY_REFUSALS)(
    "shows the $code refusal in the operator's words",
    async ({ code, status, message, toast, fromServerMessage }) => {
      await lookUp(userFixture());
      actionResponse = () => jsonResponse({ error: { code, message } }, status);

      await confirmDeidentify();

      await waitFor(() => {
        expect(screen.getByText(toast)).toBeTruthy();
      });
      expect(toastOf(toast)?.getAttribute("data-toast-type")).toBe("error");

      // The other half of the same claim: on the codes that have copy, the message the server packed
      // beside the code is not what the operator reads. Only the two institution codes, and the two
      // the console has no copy for, are allowed to pass the server's prose through.
      const fallback = `${code}: ${message}`;

      if (fromServerMessage !== true && toast !== fallback) {
        expect(screen.queryByText(fallback)).toBeNull();
      }
    },
  );
});
