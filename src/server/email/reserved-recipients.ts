/**
 * Recipients at reserved, non-routable top-level domains, refused at the send boundary.
 *
 * The seeded test matrix addresses every fixture user at `@seed.lombakita.local`, and a deployment
 * that runs a seed with delivery enabled hands every one of them to the provider. None can be
 * delivered — the TLDs below are reserved precisely so they never resolve — so each becomes a hard
 * bounce, and a run of hard bounces is what costs a sending domain its reputation. The damage is
 * done to the DOMAIN, not to the environment that caused it, so a preview deployment can spend the
 * reputation production depends on.
 *
 * NO ENVIRONMENT EXEMPTION, and none can be added: a gate keyed on APP_ENV is a per-PROCESS
 * property, and the process that sends is the Railway worker rather than the one that enqueued the
 * job. A recipient travels with the message and can be judged wherever it is about to be sent.
 */

// RFC 2606 reserves test/example/invalid/localhost; RFC 6762 reserves local for mDNS. Data rather
// than a regex or a chain of endsWith, because the set is the thing under test: the pin beside this
// asserts that what is declared here is exactly what gets refused.
export const RESERVED_RECIPIENT_TLDS = Object.freeze([
  "test",
  "local",
  "invalid",
  "example",
  "localhost",
] as const);

export class ReservedRecipientError extends Error {
  readonly tld: string;
  readonly kind: string;

  constructor(tld: string, kind: string) {
    super(
      `Refusing to send "${kind}" to a recipient at reserved TLD ".${tld}". Addresses there are ` +
        "never routable, so the send can only produce a hard bounce against this sending domain",
    );
    this.name = "ReservedRecipientError";
    this.tld = tld;
    this.kind = kind;
  }
}

/**
 * The reserved TLD an address sits under, or null when it is routable.
 *
 * A bare `user@localhost` carries no dot at all, so the whole domain is the label to compare.
 */
export const reservedTldOf = (address: string): string | null => {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;

  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return null;

  const lastDot = domain.lastIndexOf(".");
  const tld = lastDot === -1 ? domain : domain.slice(lastDot + 1);

  return RESERVED_RECIPIENT_TLDS.includes(tld as (typeof RESERVED_RECIPIENT_TLDS)[number])
    ? tld
    : null;
};

export const assertRecipientIsRoutable = (address: string, kind: string): void => {
  const tld = reservedTldOf(address);
  if (tld === null) return;

  throw new ReservedRecipientError(tld, kind);
};
