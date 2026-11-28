// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  REFUSED_FIRST_LABELS,
  matchedTickDomain,
  normalizedWebsiteHostOf,
  tickOrganizationDomainOf,
  websiteHostOf,
} from "./tick-domain";

describe("tickOrganizationDomainOf", () => {
  it.each([...REFUSED_FIRST_LABELS])("returns null for the generic first label %s", (label) => {
    expect(tickOrganizationDomainOf(`${label}.xx`)).toBeNull();
  });

  it.each(["acme.example", "univ.ac.id", "kampus.id"])("keeps %s", (domain) => {
    expect(tickOrganizationDomainOf(domain)).toBe(domain);
  });

  it("reads the organization domain under a listed second-level suffix and under a subdomain", () => {
    expect(tickOrganizationDomainOf("mail.univ.ac.id")).toBe("univ.ac.id");
    expect(tickOrganizationDomainOf("students.acme.example")).toBe("acme.example");
  });

  it("returns null for an address that is an IP literal", () => {
    expect(tickOrganizationDomainOf("5.6.3.4")).toBeNull();
  });

  it("returns null for a free provider and for a name no mail reaches", () => {
    expect(tickOrganizationDomainOf("gmail.com")).toBeNull();
    expect(tickOrganizationDomainOf("pemilik.local")).toBeNull();
  });
});

describe("matchedTickDomain", () => {
  it("matches an email subdomain to the website's own domain", () => {
    expect(matchedTickDomain("students.acme.example", "https://www.acme.example")).toBe(
      "acme.example",
    );
  });

  it("does not match two organizations under one generic second-level name", () => {
    expect(matchedTickDomain("x.com.br", "https://y.com.br")).toBeNull();
  });

  it("does not match another organization", () => {
    expect(matchedTickDomain("students.acme.example", "https://other.example")).toBeNull();
  });

  it("does not match a website that is not a web address", () => {
    expect(matchedTickDomain("acme.example", "ftp://acme.example")).toBeNull();
    expect(matchedTickDomain("acme.example", "not a url")).toBeNull();
  });
});

describe("websiteHostOf", () => {
  it("refuses an IPv4 or bracketed IPv6 website host", () => {
    expect(websiteHostOf("https://9.9.3.4")).toBeNull();
    expect(websiteHostOf("https://[2001:db8::1]")).toBeNull();
    expect(matchedTickDomain("9.9.3.4", "https://9.9.3.4")).toBeNull();
    expect(websiteHostOf("https://www.acme.example")).toBe("www.acme.example");
  });

  it("lower-cases the host and accepts http as well as https", () => {
    expect(websiteHostOf("http://WWW.Acme.Example/path")).toBe("www.acme.example");
  });
});

describe("normalizedWebsiteHostOf", () => {
  it("drops one leading www and lower-cases the host", () => {
    expect(normalizedWebsiteHostOf("https://WWW.Acme.Example/")).toBe("acme.example");
    expect(normalizedWebsiteHostOf("https://portal.acme.example")).toBe("portal.acme.example");
  });

  it("is null when the url does not parse", () => {
    expect(normalizedWebsiteHostOf("not a url")).toBeNull();
  });
});
