import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";
// Throwaway domains: disposable_email_blocklist.conf of https://github.com/disposable-email-domains/disposable-email-domains (CC0) at commit 9cf2bee345b0276e1b65cee7484beb51e5c715b1, refreshed by hand.
import disposableEmailDomains from "./disposable-email-domains.json";

const THROWAWAY_EMAIL_DOMAINS: ReadonlySet<string> = new Set(disposableEmailDomains);

const DOMAIN_LABEL_PATTERN = /^[a-z0-9-]+$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]*$/;

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
