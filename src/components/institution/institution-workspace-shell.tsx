"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  FormActionBar,
  FormError,
  FormHelp,
  FormInput,
  FormLabel,
  IconButton,
  PageHeader,
  SelectField,
  focusFirstInvalidField,
  usePageTransition,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
// Type-only: importing the enum value would pull the Drizzle schema into the client bundle.
import type { InstitutionType } from "@/server/db/schema";

const TYPE_OPTIONS = Object.entries(INSTITUTION_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const KIND_MISSING_MESSAGE = "Pilih jenis institusi.";

const USERNAME_CLASH_CODE = "institution_slug_conflicts_with_username";

const USERNAME_CLASH_MESSAGE =
  "Alamat institusi ini sama dengan username sebuah akun. Ubah nama institusi atau isi slug lain.";

const CREATE_ERROR_COPY: Partial<Record<string, string>> = {
  recruiter_role_not_verified:
    "Verifikasi akun penyelenggara Anda terlebih dahulu untuk membuat institusi.",
  recruiter_tier_insufficient:
    "Akun Anda belum menjadi penyelenggara terverifikasi. Selesaikan verifikasi penyelenggara untuk dapat membuat institusi.",
  recruiter_institution_limit_reached: "Satu akun hanya dapat memiliki 3 institusi.",
  institution_invalid_value: "Periksa nama institusi dan slug lalu coba lagi.",
  institution_display_name_reserved: "Nama institusi ini tidak dapat digunakan. Pilih nama lain.",
  institution_slug_reserved: "Slug ini tidak dapat digunakan. Pilih slug lain.",
  institution_create_blocked_trust_removed:
    "Status tepercaya akun Anda dicabut staf, jadi Anda tidak dapat membuat institusi baru. Institusi yang sudah Anda kelola tetap ada. Hubungi staf Lombakita jika ada pertanyaan.",
  account_deactivated: "Data akun ini sudah dihapus. Tindakan ini tidak tersedia.",
};

const CREATE_FALLBACK = "Permintaan ruang kerja institusi gagal diproses.";

type CreatedInstitutionResponse = {
  institution: {
    slug: string;
  };
};

export const InstitutionWorkspaceShell = ({ expectedUserId }: { expectedUserId: string }) => {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [institutionType, setInstitutionType] = useState<InstitutionType | "">("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const { addToast } = useToast();
  const { runAndNavigate } = usePageTransition();
  const showsKindError = hasTriedToSubmit && institutionType === "";
  const [showsUsernameClash, setShowsUsernameClash] = useState(false);
  // A refused submit moves focus to the field it marks, after the render that marks it.
  const formRef = useRef<HTMLFormElement>(null);
  const [errorFocusRequest, setErrorFocusRequest] = useState(0);
  useEffect(() => {
    if (errorFocusRequest === 0) return;
    focusFirstInvalidField(formRef.current);
  }, [errorFocusRequest]);

  // A new name or slug clears the username clash the last refusal marked on the name field.
  const changeDisplayName = (value: string) => {
    setDisplayName(value);
    setShowsUsernameClash(false);
  };

  const changeSlug = (value: string) => {
    setSlug(value);
    setShowsUsernameClash(false);
  };

  // No kind is preselected, so a host picks one on purpose: the kind is fixed at creation.
  const onSubmit = (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setHasTriedToSubmit(true);
    if (institutionType === "") {
      setErrorFocusRequest((request) => request + 1);
      return;
    }
    return runAndNavigate(() => createInstitution(institutionType), {
      message: "Membuat institusi…",
    });
  };

  // Returns whether a navigation was started, so a rejected create drops the blocking screen
  // instead of leaving the user staring at it.
  const createInstitution = async (kind: InstitutionType): Promise<boolean> => {
    if (displayName.trim().length < 2) {
      addToast({ type: "error", message: "Nama institusi minimal terdiri dari 2 karakter." });
      return false;
    }

    setIsCreating(true);

    const payload: {
      displayName: string;
      slug?: string;
      institutionType: InstitutionType;
    } = {
      displayName,
      institutionType: kind,
    };

    if (slug.trim().length > 0) {
      payload.slug = slug;
    }

    let response: Response;
    try {
      response = await sessionFetch(expectedUserId, "/api/v1/institutions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
      setIsCreating(false);
      return false;
    }

    if (!response.ok) {
      const code = await readErrorCode(response);
      setIsCreating(false);
      // The address derives from the name unless a slug is typed, so the clash is shown on the name
      // field, next to what the host changes to fix it.
      if (code === USERNAME_CLASH_CODE) {
        setShowsUsernameClash(true);
        return false;
      }
      addToast({
        type: "error",
        message: errorMessageFor(code, CREATE_ERROR_COPY, CREATE_FALLBACK),
      });
      return false;
    }

    const data = (await response.json()) as CreatedInstitutionResponse;
    addToast({ type: "success", message: "Institusi berhasil dibuat." });
    setIsCreating(false);
    router.replace(`/institution/${data.institution.slug}`);
    return true;
  };

  return (
    <main className="page-shell app-page institution-form-page">
      <PageHeader
        title="Buat institusi"
        description="Isi identitas institusi. Slug bisa dikosongkan, nanti kami buatkan otomatis."
      />

      <section className="content-section">
        <form ref={formRef} className="stack-md" onSubmit={onSubmit}>
          <div className="form-field">
            <FormLabel htmlFor="institution-display-name" required>
              Nama institusi
            </FormLabel>
            <FormInput
              id="institution-display-name"
              autoComplete="organization"
              value={displayName}
              onChange={(event) => changeDisplayName(event.target.value)}
              placeholder="Contoh: Universitas Nusantara"
              required
              aria-invalid={showsUsernameClash}
              aria-describedby={showsUsernameClash ? "institution-display-name-error" : undefined}
            />
            {showsUsernameClash ? (
              <FormError id="institution-display-name-error">{USERNAME_CLASH_MESSAGE}</FormError>
            ) : null}
          </div>

          <div className="form-field">
            <FormLabel htmlFor="institution-type" required>
              Jenis institusi
            </FormLabel>
            <SelectField
              id="institution-type"
              label="Jenis institusi"
              required
              placeholder="Pilih jenis institusi"
              value={institutionType}
              onChange={(value) => setInstitutionType(value as InstitutionType)}
              options={TYPE_OPTIONS}
              aria-invalid={showsKindError}
              aria-describedby={showsKindError ? "institution-type-error" : undefined}
            />
            {showsKindError ? (
              <FormError id="institution-type-error">{KIND_MISSING_MESSAGE}</FormError>
            ) : null}
            <FormHelp>
              Pilih Pribadi jika Anda menyelenggarakan atas nama sendiri. Nama dan alamat institusi
              bisa diubah nanti di pengaturan.
            </FormHelp>
          </div>

          <div className="form-field">
            <FormLabel htmlFor="institution-slug" optional>
              Slug
            </FormLabel>
            <FormInput
              id="institution-slug"
              value={slug}
              onChange={(event) => changeSlug(event.target.value)}
              placeholder="universitas-nusantara"
            />
          </div>
        </form>
      </section>

      <FormActionBar>
        <IconButton
          variant="plain"
          size="back"
          icon="arrow-left"
          label="Kembali ke Dasbor penyelenggara"
          onClick={() => router.push("/recruiter-dashboard")}
        />
        <div className="form-action-bar-end">
          <Button type="button" onClick={() => onSubmit()} loading={isCreating}>
            Buat institusi
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
