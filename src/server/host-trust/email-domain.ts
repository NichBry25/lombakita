import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";
// Throwaway domains: disposable_email_blocklist.conf of https://github.com/disposable-email-domains/disposable-email-domains (CC0) at commit 9cf2bee345b0276e1b65cee7484beb51e5c715b1, refreshed by hand.
import disposableEmailDomains from "./disposable-email-domains.json";

const THROWAWAY_EMAIL_DOMAINS: ReadonlySet<string> = new Set(disposableEmailDomains);

const DOMAIN_LABEL_PATTERN = /^[a-z0-9-]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

// Second-level suffixes under which an organization registers its own name, so its domain is the
// label in front of the suffix. Under an unlisted suffix every organization shares one domain, which
// counts more tries together and never trusts more.
const SECOND_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "ac.id",
  "co.id",
  "or.id",
  "go.id",
  "sch.id",
  "net.id",
  "web.id",
  "my.id",
  "biz.id",
  "mil.id",
  "ponpes.id",
  "desa.id",
  "co.uk",
  "ac.uk",
  "org.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.jp",
  "ac.jp",
  "com.sg",
  "edu.sg",
  "com.my",
  "edu.my",
]);

const isListedDomain = (domain: string): boolean =>
  PERSONAL_EMAIL_DOMAINS.has(domain) || THROWAWAY_EMAIL_DOMAINS.has(domain);

const parentDomainsOf = (domain: string): string[] => {
  const labels = domain.split(".");
  const parents: string[] = [];
  for (let start = 1; labels.length - start >= 2; start += 1) {
    parents.push(labels.slice(start).join("."));
  }
  return parents;
};

export const extractEmailDomain = (email: string): string | null => {
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [, domain] = parts;
  if (!domain) return null;
  const lowerCaseDomain = domain.toLowerCase();
  const labels = lowerCaseDomain.split(".");
  // A domain with an empty or non-ASCII label is not a domain, so it can never read as an organization domain.
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) return null;
  return lowerCaseDomain;
};

// The table CHECKs lower-case with Postgres lower(), which can differ from toLowerCase() on non-ASCII letters, so only printable ASCII may reach them.
export const holdsOnlyPrintableAscii = (text: string): boolean =>
  PRINTABLE_ASCII_PATTERN.test(text);

// Parent domains stop at two labels, so a public suffix such as co.id is never looked up on its own.
export const isFreeOrThrowawayEmailDomain = (domain: string): boolean => {
  const normalizedDomain = domain.toLowerCase();
  const candidates = [normalizedDomain, ...parentDomainsOf(normalizedDomain)];
  return candidates.some(isListedDomain);
};

// Last labels no mail can reach, so an address under them can never be shown to be an
// organisation's. The seed signs every account in under .local. The reserved names example and test
// stay organisation domains, because test fixtures use them as organisations and no real person
// receives mail there.
const UNREACHABLE_LAST_LABELS: ReadonlySet<string> = new Set(["local", "invalid", "localhost"]);

const endsInUnreachableLabel = (domain: string): boolean => {
  const labels = domain.toLowerCase().split(".");
  const lastLabel = labels[labels.length - 1] ?? "";
  return UNREACHABLE_LAST_LABELS.has(lastLabel);
};

// Whether an address on this domain can never make its holder a trusted host: a free provider, a
// throwaway service, or a name no mail reaches.
export const isNeverOrganizationEmailDomain = (domain: string): boolean =>
  isFreeOrThrowawayEmailDomain(domain) || endsInUnreachableLabel(domain);

// The domain whose code tries count together for one organization, read from a domain that
// extractEmailDomain returned. Under an unlisted second-level suffix it is the suffix itself.
export const organizationDomainOf = (domain: string): string => {
  const labels = domain.split(".");
  const lastTwoLabels = labels.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwoLabels)) return labels.slice(-3).join(".");
  return lastTwoLabels;
};
