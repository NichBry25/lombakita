"use client";

import { Button, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";

type Props = {
  competitionId: string;
  title: string;
  eventStartAt: string | null;
  eventEndAt: string | null;
  description: string;
};

// ICS text values escape backslash, semicolon, comma, and newline (RFC 5545 §3.3.11).
const escapeIcsText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Basic UTC form: YYYYMMDDTHHMMSSZ.
const toIcsUtc = (iso: string): string =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const buildIcs = ({
  competitionId,
  title,
  eventStartAt,
  eventEndAt,
  description,
}: Props): string => {
  const start = eventStartAt as string; // caller renders the button only when start is present
  const end = eventEndAt ?? eventStartAt ?? start;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lombakita//Kompetisi//ID",
    "BEGIN:VEVENT",
    `UID:${competitionId}@lombakita`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((line): line is string => line !== null);
  return lines.join("\r\n");
};

export function DetailActions(props: Props) {
  const { addToast } = useToast();
  const { title, eventStartAt } = props;

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // User dismissed the share sheet, or share failed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      addToast({ type: "success", message: "Tautan disalin ke papan klip." });
    } catch {
      addToast({ type: "error", message: "Gagal menyalin tautan. Coba lagi." });
    }
  };

  const handleAddToCalendar = () => {
    const ics = buildIcs(props);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kompetisi.ics";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="detail-secondary-actions cluster">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        leadingIcon={<Icon name="link" size="sm" />}
        onClick={handleShare}
      >
        Bagikan
      </Button>
      {eventStartAt ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          leadingIcon={<Icon name="calendar" size="sm" />}
          onClick={handleAddToCalendar}
        >
          Tambahkan ke kalender
        </Button>
      ) : null}
    </div>
  );
}
