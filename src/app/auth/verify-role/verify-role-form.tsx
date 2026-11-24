"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Button,
  ButtonLink,
  Feedback,
  FormInput,
  FormLabel,
  Icon,
  SelectField,
  usePageTransition,
} from "@/components/ui";
import type { VerifiableRole } from "@/server/auth/role-verification";
import { useToast } from "@/components/ui/primitives";
import { OrganizationEmailField } from "@/components/host/organization-email-field";
import {
  errorMessageFor,
  ONBOARDING_FIELD_REFUSAL_COPY,
  refusalCopyKey,
} from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";

const VERIFY_ROLE_ERROR_COPY: Partial<Record<string, string>> = {
  role_already_verified: "Akun Anda sudah terverifikasi untuk peran ini.",
  ...ONBOARDING_FIELD_REFUSAL_COPY,
  candidate_profile_invalid_value: "Periksa data kandidat Anda lalu coba lagi.",
  user_not_found: "Akun tidak ditemukan. Masuk lagi lalu coba lagi.",
  forbidden: "Akun ini tidak dapat menambah peran kandidat atau penyelenggara.",
};

const VERIFY_ROLE_FALLBACK = "Verifikasi gagal. Coba lagi beberapa saat.";

export type RegisteredContact = { fullName: string; phoneNumber: string };

type VerifyRoleFormProps = {
  role: VerifiableRole;
  expectedUserId: string;
  // A path on this site that the page has already checked, or null for the dashboard the API names.
  returnPath: string | null;
  // The name and phone the account gave at sign-up, shown read only on the host step.
  registeredContact: RegisteredContact | null;
};

// Candidate onboarding option list. Values must match the `candidate_occupation` DB enum exactly.
const OCCUPATION_OPTIONS = [
  { value: "school_student", label: "Pelajar (SMA/SMK/sederajat)" },
  { value: "college_student", label: "Mahasiswa" },
  { value: "new_graduate", label: "Lulusan baru" },
  { value: "professional", label: "Profesional / bekerja" },
  { value: "other", label: "Lainnya" },
] as const;

// Calls the completion API and refreshes the session JWT so the new verifiedRoles entry is
// reflected without a manual re-login. The participant step sends the four details, the same as the
// sign-up form. The host step sends only the role, and a host whose account is trusted once the
// step commits is told so before going on.
export function VerifyRoleForm({
  role,
  expectedUserId,
  returnPath,
  registeredContact,
}: VerifyRoleFormProps) {
  const { update } = useSession();
  const { addToast } = useToast();
  const { begin: beginPageTransition } = usePageTransition();
  const [busy, setBusy] = useState(false);
  const [trustedContinueHref, setTrustedContinueHref] = useState<string | null>(null);
  const trustedNoticeRef = useRef<HTMLDivElement>(null);

  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [occupation, setOccupation] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // The host step's button unmounts when the trusted notice replaces it, so focus moves to the
  // notice.
  useEffect(() => {
    if (trustedContinueHref !== null) {
      trustedNoticeRef.current?.focus();
    }
  }, [trustedContinueHref]);

  const submit = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await sessionFetch(expectedUserId, "/api/v1/auth/verify-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; details?: { fields?: string[] } };
        } | null;
        const copyKey = refusalCopyKey(
          payload?.error?.code,
          payload?.error?.details?.fields?.[0],
          VERIFY_ROLE_ERROR_COPY,
        );
        addToast({
          type: "error",
          message: errorMessageFor(copyKey, VERIFY_ROLE_ERROR_COPY, VERIFY_ROLE_FALLBACK),
        });
        setBusy(false);
        return;
      }

      const payload = (await response.json()) as { redirectTo: string; hostTrusted?: boolean };

      // Refresh the JWT so the next page render sees the updated verifiedRoles. We MUST await
      // this before navigating — otherwise the destination dashboard's server-side check would
      // read a stale session.
      await update();

      const nextHref = returnPath ?? payload.redirectTo;
      if (role === "recruiter" && payload.hostTrusted === true) {
        setTrustedContinueHref(nextHref);
        setBusy(false);
        return;
      }

      beginPageTransition("Menyiapkan akun Anda…");
      window.location.assign(nextHref);
    } catch {
      addToast({
        type: "error",
        message: "Verifikasi gagal karena gangguan koneksi. Periksa jaringan Anda lalu coba lagi.",
      });
      setBusy(false);
    }
  };

  if (role === "recruiter") {
    if (trustedContinueHref !== null) {
      return (
        <div ref={trustedNoticeRef} tabIndex={-1} className="stack-md">
          <Feedback tone="success">
            Akun Anda tepercaya. Kompetisi yang Anda terbitkan langsung tayang.
          </Feedback>
          <ButtonLink href={trustedContinueHref} variant="primary" size="md">
            Lanjut
            <Icon name="arrow-right" size="md" />
          </ButtonLink>
        </div>
      );
    }

    return (
      <div className="stack-md">
        {registeredContact ? (
          <>
            <p>Nama dan nomor ponsel diambil dari data pendaftaran Anda.</p>
            <div className="form-field">
              <FormLabel htmlFor="host-step-full-name">Nama</FormLabel>
              <FormInput
                id="host-step-full-name"
                type="text"
                value={registeredContact.fullName}
                readOnly
              />
            </div>
            <div className="form-field">
              <FormLabel htmlFor="host-step-phone">Nomor ponsel</FormLabel>
              <FormInput
                id="host-step-phone"
                type="tel"
                value={registeredContact.phoneNumber}
                readOnly
              />
            </div>
          </>
        ) : null}

        <OrganizationEmailField expectedUserId={expectedUserId} />

        <p className="form-help">
          Tanpa email organisasi, kompetisi pertama Anda diperiksa staf sebelum tayang. Perkiraan
          1x24 jam pada hari kerja.
        </p>

        <Button
          type="button"
          loading={busy}
          onClick={() => void submit({ role })}
          data-testid="verify-role-recruiter"
        >
          Mulai menyelenggarakan
        </Button>
      </div>
    );
  }

  const onSubmitCandidate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (fullName.trim().length < 2) {
      addToast({ type: "error", message: "Isi nama lengkap (minimal 2 karakter)." });
      return;
    }
    if (phoneNumber.replace(/\D/g, "").length < 8) {
      addToast({ type: "error", message: "Isi nomor telepon yang valid (minimal 8 digit)." });
      return;
    }
    if (!occupation) {
      addToast({ type: "error", message: "Pilih status Anda saat ini." });
      return;
    }
    if (!dateOfBirth) {
      addToast({ type: "error", message: "Isi tanggal lahir Anda." });
      return;
    }

    void submit({
      role,
      fullName: fullName.trim(),
      phoneNumber: phoneNumber.trim(),
      occupation,
      dateOfBirth,
    });
  };

  return (
    <form onSubmit={onSubmitCandidate} className="auth-form">
      <p>Lengkapi data kandidat Anda. Data ini bisa diubah nanti di dasbor Anda.</p>

      <div className="form-field">
        <FormLabel htmlFor="candidate-full-name" required>
          Nama lengkap
        </FormLabel>
        <FormInput
          id="candidate-full-name"
          type="text"
          autoComplete="name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          placeholder="Nama lengkap sesuai identitas"
        />
      </div>

      <div className="form-field">
        <FormLabel htmlFor="candidate-phone" required>
          Nomor telepon
        </FormLabel>
        <FormInput
          id="candidate-phone"
          type="tel"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          placeholder="Contoh: 0812xxxxxxx"
        />
      </div>

      <div className="form-field">
        <FormLabel htmlFor="candidate-occupation" required>
          Status saat ini
        </FormLabel>
        <SelectField
          id="candidate-occupation"
          label="Status saat ini"
          required
          value={occupation}
          placeholder="Pilih status Anda"
          options={[...OCCUPATION_OPTIONS]}
          onChange={setOccupation}
        />
      </div>

      <div className="form-field">
        <FormLabel htmlFor="candidate-dob" required>
          Tanggal lahir
        </FormLabel>
        <FormInput
          id="candidate-dob"
          type="date"
          value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)}
        />
      </div>

      <Button type="submit" loading={busy} data-testid="verify-role-candidate">
        Selesai
      </Button>
    </form>
  );
}
