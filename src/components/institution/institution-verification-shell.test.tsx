// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { InstitutionVerificationShell } from "./institution-verification-shell";

const { mockPush, mockRefresh, mockSessionFetch } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockSessionFetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

// Only sessionFetch is replaced: readErrorCode and the session-mismatch code and sentence stay real,
// because error-copy.ts reads the last two when it is imported.
vi.mock("@/lib/session/session-fetch", async () => ({
  ...(await vi.importActual("@/lib/session/session-fetch")),
  sessionFetch: mockSessionFetch,
}));

const mount = () =>
  render(
    <UIPrimitivesProvider>
      <InstitutionVerificationShell
        institutionSlug="institusi-contoh"
        expectedUserId="user-1"
        institutionType="university"
        isVerified={false}
        verifiedAt={null}
        rejectionReason={null}
      />
    </UIPrimitivesProvider>,
  );

const attachDocumentAndSubmit = async () => {
  const input = await screen.findByLabelText(/^SK pendirian(?: \* \(wajib\)| \(opsional\))?$/);
  const file = new File(["%PDF-1.4"], "sk-pendirian.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Kirim dokumen" }));
};

describe("InstitutionVerificationShell submit", () => {
  beforeEach(() => {
    // The history GET is a plain fetch; a fresh Response per call, because a body is read once.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(JSON.stringify({ submissions: [] }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the pending sentence and refreshes the page when a submission is already pending", async () => {
    mockSessionFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "verification_submission_already_pending" } }), {
        status: 409,
      }),
    );
    mount();

    await attachDocumentAndSubmit();

    expect(
      await screen.findByText("Pengajuan verifikasi untuk institusi ini masih menunggu tinjauan."),
    ).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockSessionFetch).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback sentence when the refusal body is not JSON", async () => {
    mockSessionFetch.mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    mount();

    await attachDocumentAndSubmit();

    expect(await screen.findByText("Pengajuan gagal dikirim. Coba lagi.")).toBeTruthy();
  });

  it("shows the connection sentence when the request itself fails", async () => {
    mockSessionFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    mount();

    await attachDocumentAndSubmit();

    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Pengajuan gagal" })).toBeTruthy();
  });
});
