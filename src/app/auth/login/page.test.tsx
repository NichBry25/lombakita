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

import LoginPage from "@/app/auth/login/page";

const callbackUrlPassedFor = async (searchParams: Record<string, string>) => {
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
  const lastProps = AuthEntry.mock.calls.at(-1)?.[0];
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
});
