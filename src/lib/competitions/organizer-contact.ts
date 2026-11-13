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

// Indonesian numbers arrive as 0812..., 62812..., +62 812..., +62 0812..., +0812..., 0062 812...,
// 000812... and the bare 812... that host sign-up accepts. Every form becomes 62 followed by the
// national number, so the same number is stored, linked and matched at account deletion the
// same way. No country code starts with 0, so a 0 written after + or 00 is still the trunk
// prefix. A number written with + or 00 and another country code keeps its digits.
export const toDialDigits = (phone: string): string | null => {
  const trimmed = phone.trim();
  const rawDigits = trimmed.replace(/\D/g, "");
  const writtenInternationally = trimmed.startsWith("+") || rawDigits.startsWith("00");
  const digits = rawDigits.startsWith("00") ? rawDigits.slice(2) : rawDigits;
  if (digits === "") return null;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("620")) return `62${digits.slice(3)}`;
  if (writtenInternationally || digits.startsWith("62")) return digits;
  if (digits.startsWith("8")) return `62${digits}`;
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
