// @vitest-environment node

import { describe, expect, it } from "vitest";
import disposableEmailDomains from "./disposable-email-domains.json";
import {
  extractEmailDomain,
  holdsOnlyPrintableAscii,
  isFreeOrThrowawayEmailDomain,
  registrableDomainOf,
} from "./email-domain";
import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";

const EXPECTED_FREE_PROVIDERS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.id",
  "yahoo.co.uk",
  "yahoo.co.jp",
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
  "protonmail.ch",
  "proton.me",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "fastmail.com",
  "hey.com",
  "naver.com",
  "rediffmail.com",
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

  it("reads no domain when a label is empty or the domain has one label", () => {
    expect(extractEmailDomain("x@gmail.com.")).toBeNull();
    expect(extractEmailDomain("x@acme..example")).toBeNull();
    expect(extractEmailDomain("budi@localhost")).toBeNull();
  });

  it("reads no domain from a domain with a character outside ASCII letters, digits and hyphens", () => {
    expect(extractEmailDomain("budi@bücher.example")).toBeNull();
    expect(extractEmailDomain("budi@acme_corp.example")).toBeNull();
  });

  it("still reads a subdomain of an organization domain as an organization domain", () => {
    expect(extractEmailDomain("a@sub.acme.example")).toBe("sub.acme.example");
    expect(isFreeOrThrowawayEmailDomain("sub.acme.example")).toBe(false);
  });

  it("tells printable ASCII text from text with any other character", () => {
    expect(holdsOnlyPrintableAscii("budi@acme.example")).toBe(true);
    expect(holdsOnlyPrintableAscii("Budİ@acme.example")).toBe(false);
    expect(holdsOnlyPrintableAscii("budi\u00a0@acme.example")).toBe(false);
    expect(holdsOnlyPrintableAscii("budi\t@acme.example")).toBe(false);
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

  it("reads the organization's registered domain under a listed second-level suffix", () => {
    expect(registrableDomainOf("a1.univ.ac.id")).toBe("univ.ac.id");
    expect(registrableDomainOf("univ.ac.id")).toBe("univ.ac.id");
  });

  it("reads the last two labels of a domain under any other suffix", () => {
    expect(registrableDomainOf("sub.acme.example")).toBe("acme.example");
    expect(registrableDomainOf("acme.example")).toBe("acme.example");
  });

  it("puts every organization under an unlisted second-level suffix in one domain", () => {
    expect(registrableDomainOf("fakultas.univ.edu.vn")).toBe("edu.vn");
    expect(registrableDomainOf("kampus.edu.vn")).toBe("edu.vn");
  });

  it("returns a listed second-level suffix that stands alone as itself", () => {
    expect(registrableDomainOf("ac.id")).toBe("ac.id");
  });
});
