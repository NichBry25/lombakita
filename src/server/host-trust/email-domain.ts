import { PERSONAL_EMAIL_DOMAINS } from "@/server/institution-verification/verification-requirements";
// Throwaway domains: disposable_email_blocklist.conf of https://github.com/disposable-email-domains/disposable-email-domains (CC0) at commit 9cf2bee345b0276e1b65cee7484beb51e5c715b1, refreshed by hand.
import disposableEmailDomains from "./disposable-email-domains.json";

const THROWAWAY_EMAIL_DOMAINS: ReadonlySet<string> = new Set(disposableEmailDomains);

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
  return domain.toLowerCase();
};

// Parent domains stop at two labels, so a public suffix such as co.id is never looked up on its own.
export const isFreeOrThrowawayEmailDomain = (domain: string): boolean => {
  const normalizedDomain = domain.toLowerCase();
  const candidates = [normalizedDomain, ...parentDomainsOf(normalizedDomain)];
  return candidates.some(isListedDomain);
};
