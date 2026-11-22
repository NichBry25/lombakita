import { ButtonLink } from "@/components/ui";
import {
  ORGANIZER_CONTACT_KIND_LABELS,
  buildOrganizerContactHref,
  formatOrganizerContactValue,
  type OrganizerContact,
} from "@/lib/competitions/organizer-contact";

export function OrganizerContactLink({ contact }: { contact: OrganizerContact }) {
  const opensChat = contact.kind === "whatsapp";
  return (
    <div className="stack-xs">
      <ButtonLink
        href={buildOrganizerContactHref(contact)}
        variant="outline"
        // A WhatsApp chat opens on another site, so it gets its own tab. A call and an email open an app.
        target={opensChat ? "_blank" : undefined}
        rel={opensChat ? "noopener noreferrer" : undefined}
      >
        Hubungi penyelenggara
      </ButtonLink>
      <p className="detail-rail-note">
        {ORGANIZER_CONTACT_KIND_LABELS[contact.kind]}:{" "}
        <span className="data-text">{formatOrganizerContactValue(contact)}</span>
      </p>
    </div>
  );
}
