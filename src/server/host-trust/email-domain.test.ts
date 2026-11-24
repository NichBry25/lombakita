// @vitest-environment node

import { describe, expect, it } from "vitest";
import disposableEmailDomains from "./disposable-email-domains.json";
import { extractEmailDomain, isFreeOrThrowawayEmailDomain } from "./email-domain";
import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";

const EXPECTED_FREE_PROVIDERS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.id",
  "ymail.com",
  "rocketmail.com",
  "outlook.com",
  "outlook.co.id",
  "hotmail.com",
  "hotmail.co.id",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "tutanota.com",
];

describe("email domains", () => {
  it("reads the lower-cased domain after the one @", () => {
    expect(extractEmailDomain("Budi@Acme.Example")).toBe("acme.example");
    expect(extractEmailDomain("budi@Sub.Acme.example")).toBe("sub.acme.example");
  });

  it("returns no domain for an address without exactly one @ or with nothing after it", () => {
    expect(extractEmailDomain("budi.acme.example")).toBeNull();
    expect(extractEmailDomain("a@b@acme.example")).toBeNull();
    expect(extractEmailDomain("budi@")).toBeNull();
  });

  it("lists exactly the free providers the trust rules name", () => {
    expect([...PERSONAL_EMAIL_DOMAINS]).toEqual(EXPECTED_FREE_PROVIDERS);
  });

  it("treats every free provider as free", () => {
    for (const domain of PERSONAL_EMAIL_DOMAINS) {
      expect(isFreeOrThrowawayEmailDomain(domain)).toBe(true);
    }
    expect(isFreeOrThrowawayEmailDomain("GMAIL.COM")).toBe(true);
  });

  it("treats a subdomain of a free provider as free", () => {
    expect(isFreeOrThrowawayEmailDomain("mx.gmail.com")).toBe(true);
    expect(isFreeOrThrowawayEmailDomain("a.b.yahoo.co.id")).toBe(true);
  });

  it("treats a vendored throwaway domain and its subdomains as throwaway", () => {
    const [firstThrowawayDomain] = disposableEmailDomains;
    if (!firstThrowawayDomain) throw new Error("The vendored list is empty");

    expect(isFreeOrThrowawayEmailDomain(firstThrowawayDomain)).toBe(true);
    expect(isFreeOrThrowawayEmailDomain(`mx.${firstThrowawayDomain}`)).toBe(true);
  });

  it("does not treat an organization domain as free", () => {
    expect(isFreeOrThrowawayEmailDomain("acme.example")).toBe(false);
    expect(isFreeOrThrowawayEmailDomain("ui.ac.id")).toBe(false);
    expect(isFreeOrThrowawayEmailDomain("co.id")).toBe(false);
    expect(isFreeOrThrowawayEmailDomain("gmail.com.acme.example")).toBe(false);
  });

  it("holds the vendored list as unique lower-case domains", () => {
    expect(disposableEmailDomains.length).toBeGreaterThan(0);
    for (const domain of disposableEmailDomains) {
      expect(domain).toBe(domain.trim().toLowerCase());
      expect(domain).toContain(".");
      expect(domain).not.toContain("@");
    }
    expect(new Set(disposableEmailDomains).size).toBe(disposableEmailDomains.length);
  });
});
