// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import type { HostStatus } from "@/server/host-trust/host-check-service";
import { HostStatusCard } from "./host-status-card";

vi.mock("next/navigation", () => ({ usePathname: () => "/recruiter-dashboard" }));

const CODE_URL = "/api/v1/me/organization-email/code";
const CONFIRM_URL = "/api/v1/me/organization-email/confirm";
const ADDRESS = "sekretaris@kampus.example";
const CODE_BOX_LABEL = /^Kode 6 angka(?: \* \(wajib\)| \(opsional\))?$/;
const EMAIL_FIELD_LABEL = /^Email organisasi(?: \(opsional\))?$/;

const TRUSTED_SENTENCE = "Akun Anda tepercaya. Kompetisi yang Anda terbitkan langsung tayang.";
const NOT_TRUSTED_SENTENCE =
  "Kompetisi pertama Anda diperiksa staf sebelum tayang. Perkiraan 1x24 jam pada hari kerja. Konfirmasi email organisasi agar langsung tayang.";

const fetchMock = vi.fn();
let answerFor: Record<string, () => Response> = {};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sentCode = () =>
  jsonResponse(200, {
    organizationEmailCode: { email: ADDRESS, expiresAt: "2026-11-25T10:10:00.000Z" },
  });

const confirmAnswering = (trustSource: string | null) => () =>
  jsonResponse(200, { organizationEmail: { email: ADDRESS, trustSource } });

const requestTo = (url: string): RequestInit | undefined => {
  const call = fetchMock.mock.calls.find(([input]) => String(input) === url);
  return call?.[1] as RequestInit | undefined;
};

const renderCard = (status: HostStatus) =>
  render(
    <UIPrimitivesProvider>
      <HostStatusCard expectedUserId="user-42" status={status} />
    </UIPrimitivesProvider>,
  );

const confirmTheOrganizationEmail = async () => {
  fireEvent.change(screen.getByLabelText(EMAIL_FIELD_LABEL), { target: { value: ADDRESS } });
  fireEvent.click(screen.getByRole("button", { name: /^Kirim/ }));
  fireEvent.change(await screen.findByLabelText(CODE_BOX_LABEL), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Cocokkan kode" }));
};

beforeEach(() => {
  answerFor = {};
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const answer = answerFor[String(input)];
    if (!answer) throw new Error(`unexpected request: ${String(input)}`);
    return answer();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the host status card", () => {
  it("says a trusted host publishes at once", () => {
    renderCard({ state: "trusted" });

    expect(screen.getByRole("heading", { name: "Status penyelenggara" })).toBeTruthy();
    expect(screen.getByText(TRUSTED_SENTENCE)).toBeTruthy();
    expect(screen.queryByLabelText(EMAIL_FIELD_LABEL)).toBeNull();
  });

  it("names the draft a waiting host sent", () => {
    renderCard({ state: "pending", competitionTitle: "Lomba Esai Nasional" });

    expect(screen.getByRole("heading", { name: "Status penyelenggara" })).toBeTruthy();
    expect(
      screen.getByText(
        'Kompetisi "Lomba Esai Nasional" sedang diperiksa staf Lombakita. Perkiraan 1x24 jam pada hari kerja.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(EMAIL_FIELD_LABEL)).toBeNull();
  });

  it("names no draft when the server gave no title", () => {
    renderCard({ state: "pending" });

    expect(screen.getByRole("heading", { name: "Status penyelenggara" })).toBeTruthy();
    expect(
      screen.getByText(
        "Kompetisi Anda sedang diperiksa staf Lombakita. Perkiraan 1x24 jam pada hari kerja.",
      ),
    ).toBeTruthy();
  });

  it("tells a host whose trust staff removed that the next competition is checked, and offers no Email organisasi", () => {
    renderCard({ state: "trust_removed" });

    expect(screen.getByRole("heading", { name: "Status penyelenggara" })).toBeTruthy();
    expect(
      screen.getByText(
        "Status tepercaya akun Anda dicabut staf. Kompetisi berikutnya diperiksa staf sebelum tayang.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(EMAIL_FIELD_LABEL)).toBeNull();
  });

  it("offers an untrusted host the Email organisasi and says what happens without it", () => {
    renderCard({ state: "not_trusted" });

    expect(screen.getByRole("heading", { name: "Status penyelenggara" })).toBeTruthy();
    expect(screen.getByText(NOT_TRUSTED_SENTENCE)).toBeTruthy();
    expect(screen.getByLabelText(EMAIL_FIELD_LABEL)).toBeTruthy();
  });

  it("turns trusted when the confirmed Email organisasi trusts the account", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = confirmAnswering("organization_email");
    renderCard({ state: "not_trusted" });

    await confirmTheOrganizationEmail();

    expect(await screen.findByText(TRUSTED_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(NOT_TRUSTED_SENTENCE)).toBeNull();
    expect(screen.queryByLabelText(EMAIL_FIELD_LABEL)).toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toContain(TRUSTED_SENTENCE));
    expect(new Headers(requestTo(CODE_URL)?.headers).get("X-Expected-User-Id")).toBe("user-42");
    expect(new Headers(requestTo(CONFIRM_URL)?.headers).get("X-Expected-User-Id")).toBe("user-42");
  });

  it("stays untrusted when the confirmed Email organisasi does not trust the account", async () => {
    answerFor[CODE_URL] = sentCode;
    answerFor[CONFIRM_URL] = confirmAnswering(null);
    renderCard({ state: "not_trusted" });

    await confirmTheOrganizationEmail();

    expect(
      await screen.findByText("Email organisasi sekretaris@kampus.example sudah terkonfirmasi."),
    ).toBeTruthy();
    expect(screen.getByText(NOT_TRUSTED_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(TRUSTED_SENTENCE)).toBeNull();
  });
});
