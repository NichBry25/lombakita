"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Button, Feedback, Icon } from "@/components/ui";
import {
  describePartLoadFailure,
  useCompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import {
  ORGANIZER_CONTACT_KINDS,
  ORGANIZER_CONTACT_KIND_LABELS,
  formatOrganizerContactValue,
  type OrganizerContact,
  type OrganizerContactKind,
} from "@/lib/competitions/organizer-contact";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import type {
  OrganizerContactForEditor,
  OrganizerContactSuggestion,
} from "@/server/competitions/competition-organizer-contact-service";

const VALUE_LABELS: Record<OrganizerContactKind, string> = {
  whatsapp: "Nomor WhatsApp",
  phone: "Nomor telepon",
  email: "Alamat email",
};

const DRAFT_NOTICE =
  "Dengan menerbitkan, Anda menyetujui kontak ini tampil untuk umum dan dapat muncul di mesin pencari.";
const LIVE_NOTICE =
  "Dengan menyimpan, Anda menyetujui kontak ini tampil untuk umum dan dapat muncul di mesin pencari.";
const CANNOT_CLEAR_MESSAGE =
  "Kontak yang sudah tersimpan dapat diganti, tetapi tidak dapat dikosongkan.";
const SAVE_FALLBACK = "Kontak gagal disimpan. Coba lagi.";

const SHARED_SAVE_COPY: Partial<Record<string, string>> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  competition_not_found: "Kompetisi tidak ditemukan.",
  competition_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_organizer_contact_not_indonesian:
    "Nomor WhatsApp harus nomor ponsel Indonesia, misalnya 0812 3456 7890. Untuk nomor lain, pilih Telepon.",
};

const NUMBER_SAVE_COPY: Partial<Record<string, string>> = {
  ...SHARED_SAVE_COPY,
  competition_organizer_contact_invalid:
    "Nomor belum valid. Tulis nomor dengan awalan 0, 62, atau kode negara dengan tanda +, misalnya 0812 3456 7890.",
};

const EMAIL_SAVE_COPY: Partial<Record<string, string>> = {
  ...SHARED_SAVE_COPY,
  competition_organizer_contact_invalid: "Alamat email belum valid. Periksa kembali penulisannya.",
};

const isNumberKind = (kind: OrganizerContactKind): boolean => kind !== "email";

export const CompetitionContactEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const [kind, setKind] = useState<OrganizerContactKind>("whatsapp");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<OrganizerContact | null>(null);
  const [isDraft, setIsDraft] = useState(false);
  const [suggestion, setSuggestion] = useState<OrganizerContactSuggestion | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const inputId = useId();
  const noticeId = useId();
  const contactUrl = `/api/v1/competitions/${encodeURIComponent(competitionId)}/contact`;

  const loadContact = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(contactUrl, { cache: "no-store", credentials: "include" });
      if (!response.ok) return;
      const loaded = (await response.json()) as OrganizerContactForEditor;
      setSaved(loaded.contact);
      setIsDraft(loaded.isDraft);
      setSuggestion(loaded.suggestion);
      setKind(loaded.contact?.kind ?? "whatsapp");
      setValue(
        loaded.contact
          ? formatOrganizerContactValue(loaded.contact)
          : (loaded.suggestion?.mobileNumber ?? ""),
      );
      setHasLoaded(true);
    } catch {
      // The failure shows in place of the fields, below.
    } finally {
      setIsLoading(false);
    }
  }, [contactUrl]);

  useEffect(() => {
    void loadContact();
  }, [loadContact]);

  const typedValue = value.trim();
  const isDirty =
    saved === null
      ? typedValue !== ""
      : kind !== saved.kind || typedValue !== formatOrganizerContactValue(saved);

  const valueForKind = (next: OrganizerContactKind): string => {
    if (isNumberKind(next) && isNumberKind(kind)) return value;
    if (saved !== null && isNumberKind(saved.kind) === isNumberKind(next)) {
      return formatOrganizerContactValue(saved);
    }
    if (next === "email") return suggestion?.email ?? "";
    return suggestion?.mobileNumber ?? "";
  };

  const switchKind = (next: OrganizerContactKind) => {
    if (next === kind) return;
    setValue(valueForKind(next));
    setKind(next);
  };

  const saveContact = async (): Promise<CompetitionPartSaveResult> => {
    const sentKind = kind;
    const sentValue = value.trim();
    if (sentValue === "") return { ok: false, errorMessage: CANNOT_CLEAR_MESSAGE };
    try {
      const response = await sessionFetch(expectedUserId, contactUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: sentKind, value: sentValue }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        const copy = isNumberKind(sentKind) ? NUMBER_SAVE_COPY : EMAIL_SAVE_COPY;
        return { ok: false, errorMessage: errorMessageFor(code, copy, SAVE_FALLBACK) };
      }
      const { contact } = (await response.json()) as { contact: OrganizerContact };
      setSaved(contact);
      setKind(contact.kind);
      setValue(formatOrganizerContactValue(contact));
      return { ok: true };
    } catch {
      return { ok: false, errorMessage: NETWORK_ERROR_MESSAGE };
    }
  };

  useCompetitionEditorPart("contact", isDirty, saveContact);

  return (
    <section className="content-section surface-card card-padding stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Kontak untuk peserta</h2>
        <p className="form-help">
          Peserta dapat menghubungi penyelenggara lewat kontak ini dari halaman kompetisi.
        </p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat…</p>
      ) : !hasLoaded ? (
        <Feedback tone="error">{describePartLoadFailure("contact")}</Feedback>
      ) : (
        <div className="stack-md">
          <div className="cluster" role="group" aria-label="Jenis kontak">
            {ORGANIZER_CONTACT_KINDS.map((option) => (
              <Button
                key={option}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={option === kind}
                leadingIcon={option === kind ? <Icon name="check" aria-hidden="true" /> : undefined}
                onClick={() => switchKind(option)}
              >
                {ORGANIZER_CONTACT_KIND_LABELS[option]}
              </Button>
            ))}
          </div>
          <div className="form-field">
            <label className="form-label form-label-required" htmlFor={inputId}>
              {VALUE_LABELS[kind]}
            </label>
            <input
              id={inputId}
              className="form-input"
              type={isNumberKind(kind) ? "tel" : "email"}
              inputMode={isNumberKind(kind) ? "tel" : "email"}
              autoComplete={isNumberKind(kind) ? "tel" : "email"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby={noticeId}
            />
            <p className="form-help" id={noticeId}>
              {isDraft ? DRAFT_NOTICE : LIVE_NOTICE}
            </p>
          </div>
        </div>
      )}
    </section>
  );
};
