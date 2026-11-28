import {
  DOMAIN_LABEL_PATTERN,
  isNeverOrganizationEmailDomain,
  organizationDomainOf,
} from "@/server/host-trust/email-domain";

// Second-level names that many organizations share under one country suffix. A domain whose
// organization domain starts with one of these is a registry, not an organization, so it never
// matches.
export const REFUSED_FIRST_LABELS: ReadonlySet<string> = new Set([
  "ac",
  "biz",
  "co",
  "com",
  "desa",
  "edu",
  "gen",
  "go",
  "gob",
  "gouv",
  "gov",
  "mil",
  "my",
  "ne",
  "net",
  "or",
  "org",
  "ponpes",
  "sch",
  "web",
]);

const ALL_DIGITS_PATTERN = /^[0-9]+$/;

const isIpv4Host = (labels: string[]): boolean =>
  labels.length === 4 && labels.every((label) => ALL_DIGITS_PATTERN.test(label));

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

export const websiteHostOf = (url: string): string | null => {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase();
  if (host.startsWith("[")) return null;

  const labels = host.split(".");
  if (isIpv4Host(labels)) return null;
  if (!labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return null;
  return host;
};

export const normalizedWebsiteHostOf = (url: string): string | null => {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
};

export const tickOrganizationDomainOf = (domain: string): string | null => {
  const organizationDomain = organizationDomainOf(domain);
  const labels = organizationDomain.split(".");
  const firstLabel = labels[0] ?? "";
  const lastLabel = labels[labels.length - 1] ?? "";

  if (REFUSED_FIRST_LABELS.has(firstLabel)) return null;
  if (ALL_DIGITS_PATTERN.test(lastLabel)) return null;
  if (isNeverOrganizationEmailDomain(domain)) return null;
  return organizationDomain;
};

export const matchedTickDomain = (emailDomain: string, websiteUrl: string): string | null => {
  const emailOrganizationDomain = tickOrganizationDomainOf(emailDomain);
  if (emailOrganizationDomain === null) return null;

  const websiteHost = websiteHostOf(websiteUrl);
  if (websiteHost === null) return null;

  const websiteOrganizationDomain = tickOrganizationDomainOf(websiteHost);
  return emailOrganizationDomain === websiteOrganizationDomain ? emailOrganizationDomain : null;
};
