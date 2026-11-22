// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { AuthEntry, resolveClaimInviteEmailByToken } = vi.hoisted(() => ({
  AuthEntry: vi.fn<(props: Record<string, unknown>) => null>(() => null),
  resolveClaimInviteEmailByToken: vi.fn(async () => "invitee@example.com"),
}));

vi.mock("@/components/auth/auth-entry", () => ({ AuthEntry }));
vi.mock("@/components/auth/oauth-role-picker", () => ({ OAuthRolePicker: () => null }));
vi.mock("@/server/auth/auth.config", () => ({
  isEmailAuthConfigured: true,
  isGoogleAuthConfigured: false,
}));
vi.mock("@/server/auth/oauth-identity-carrier", () => ({
  verifyGoogleIdentityCarrier: () => null,
}));
vi.mock("@/server/invitations/invite-resolution", () => ({ resolveClaimInviteEmailByToken }));
vi.mock("@/server/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/config/env.server", () => ({ serverEnv: { authUrl: "https://lombakita.local" } }));

import LoginPage from "@/app/auth/login/page";

const authEntryPropsFor = async (searchParams: Record<string, string>) => {
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
  return AuthEntry.mock.calls.at(-1)?.[0];
};

const callbackUrlPassedFor = async (searchParams: Record<string, string>) => {
  const lastProps = await authEntryPropsFor(searchParams);
  return lastProps?.callbackUrl;
};

describe("the sign-in page return address", () => {
  it("passes a path on this site through", async () => {
    const callbackUrl = await callbackUrlPassedFor({ callbackUrl: "/competitions/acme/lomba-1" });

    expect(callbackUrl).toBe("/competitions/acme/lomba-1");
  });

  it("drops a return address to another site", async () => {
    const callbackUrl = await callbackUrlPassedFor({ callbackUrl: "//example.com" });

    expect(callbackUrl).toBeUndefined();
  });

  it("drops a backslash return address", async () => {
    const callbackUrl = await callbackUrlPassedFor({ callbackUrl: "/\\example.com" });

    expect(callbackUrl).toBeUndefined();
  });

  it("sends an invite claim to the inbox", async () => {
    const callbackUrl = await callbackUrlPassedFor({ invite: "tok" });

    expect(callbackUrl).toBe("/inbox");
  });

  it("keeps a path on this site over the inbox for an invite", async () => {
    const callbackUrl = await callbackUrlPassedFor({
      invite: "tok",
      callbackUrl: "/competitions/acme/lomba-1",
    });

    expect(callbackUrl).toBe("/competitions/acme/lomba-1");
  });

  it("sends an invite to the inbox when its return address is another site", async () => {
    const callbackUrl = await callbackUrlPassedFor({ invite: "tok", callbackUrl: "//example.com" });

    expect(callbackUrl).toBe("/inbox");
  });

  it("keeps the path of an absolute return address on this site", async () => {
    // The shape next-auth hands back after a cancelled Google attempt.
    const callbackUrl = await callbackUrlPassedFor({
      callbackUrl: "https://lombakita.local/competitions/acme/lomba-1",
      error: "Callback",
    });

    expect(callbackUrl).toBe("/competitions/acme/lomba-1");
  });

  it("drops an absolute return address on another site", async () => {
    const callbackUrl = await callbackUrlPassedFor({
      callbackUrl: "https://example.com/competitions/acme/lomba-1",
    });

    expect(callbackUrl).toBeUndefined();
  });

  it("drops a return address longer than 512 characters", async () => {
    const callbackUrl = await callbackUrlPassedFor({ callbackUrl: "/" + "a".repeat(512) });

    expect(callbackUrl).toBeUndefined();
  });
});

describe("the sign-in page refusal notices", () => {
  it("tells a person Google could not verify to sign up by email and code", async () => {
    const props = await authEntryPropsFor({ error: "oauth_email_unverified" });

    expect(props?.initialErrorMessage).toBe(
      "Google belum memverifikasi email ini, sehingga akun tidak dapat dibuat dengan Google. Daftar dengan email dan password, lalu masukkan kode verifikasi yang kami kirim ke email Anda.",
    );
  });
});
