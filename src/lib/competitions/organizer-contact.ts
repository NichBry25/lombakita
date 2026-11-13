// The contact a host sets for participants, as stored and as shown. The server, the editor and
// the competition page read it, so it imports types only.
import type { organizerContactKindEnum } from "@/server/db/schema";

export type OrganizerContactKind = (typeof organizerContactKindEnum.enumValues)[number];

export type OrganizerContact = { kind: OrganizerContactKind; value: string };

export const ORGANIZER_CONTACT_KINDS: readonly OrganizerContactKind[] = [
  "whatsapp",
  "phone",
  "email",
];

export const ORGANIZER_CONTACT_KIND_LABELS: Record<OrganizerContactKind, string> = {
  whatsapp: "WhatsApp",
  phone: "Telepon",
  email: "Email",
};

export const toOrganizerContact = (
  kind: OrganizerContactKind | null,
  value: string | null,
): OrganizerContact | null => {
  if (kind === null || value === null) return null;
  return { kind, value };
};

// A leading 0 is the Indonesian trunk prefix, so it becomes the country code 62. A number that
// starts with neither 0 nor 62 and was not written with + names no country, so it gives null.
export const toDialDigits = (phone: string): string | null => {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("62") || trimmed.startsWith("+")) return digits;
  return null;
};

export const buildOrganizerContactHref = (contact: OrganizerContact): string => {
  switch (contact.kind) {
    case "whatsapp":
      return `https://wa.me/${contact.value}`;
    case "phone":
      return `tel:+${contact.value}`;
    case "email":
      return `mailto:${contact.value}`;
  }
};

export const formatOrganizerContactValue = (contact: OrganizerContact): string =>
  contact.kind === "email" ? contact.value : `+${contact.value}`;
