"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Feedback,
  FormActionBar,
  FormHelp,
  FormInput,
  FormLabel,
  Icon,
  IconButton,
  PageHeader,
  SelectField,
  usePageTransition,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
// Type-only: importing the enum VALUE would pull the Drizzle schema into the client bundle. The
// exhaustive Record the options are built from is keyed by FullInstitutionType, so a new full
// subtype fails to build until it is given a label.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";
import { FULL_INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";

const FULL_TYPE_OPTIONS = Object.entries(FULL_INSTITUTION_TYPE_LABELS).map(([value, label]) => ({
  value: value as FullInstitutionType,
  label,
}));

type UpgradeResponse = {
  institutionType: FullInstitutionType;
  displayName: string;
  slug: string;
};

const UPGRADE_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Verifikasi akun penyelenggara Anda terlebih dahulu untuk meningkatkan institusi.",
  invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  institution_invalid_value: "Periksa nama institusi lalu coba lagi.",
  institution_display_name_reserved: "Nama institusi ini tidak dapat digunakan. Pilih nama lain.",
  institution_upgrade_tier_insufficient:
    "Peningkatan institusi hanya tersedia untuk penyelenggara terverifikasi. Selesaikan verifikasi akun Anda terlebih dahulu.",
  institution_not_found: "Institusi tidak ditemukan.",
  institution_upgrade_forbidden: "Hanya pemilik institusi yang dapat meningkatkan institusi ini.",
  institution_type_transition_forbidden:
    "Institusi ini sudah menjadi institusi resmi, jadi tidak dapat ditingkatkan lagi.",
  institution_upgrade_limit_reached: "Satu akun hanya dapat memiliki 3 institusi.",
  institution_upgrade_slug_unavailable:
    "Alamat institusi tidak dapat dibuat dari nama ini. Coba nama lain.",
  institution_upgrade_conflict: "Jenis institusi sudah berubah. Muat ulang halaman lalu coba lagi.",
};

const UPGRADE_FALLBACK = "Peningkatan institusi gagal diproses. Coba lagi.";

type InstitutionUpgradeShellProps = {
  institutionSlug: string;
  expectedUserId: string;
  // False when the owner is not yet a Trusted Recruiter. The server refuses the upgrade regardless;
  // this only drives the explanation for the disabled submit.
  canUpgrade: boolean;
};

export const InstitutionUpgradeShell = ({
  institutionSlug,
  expectedUserId,
  canUpgrade,
}: InstitutionUpgradeShellProps) => {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();
  const { runAndNavigate } = usePageTransition();

  const nameFieldId = useId();
  const nameHintId = `${nameFieldId}-hint`;
  const blockedNoticeId = useId();

  const [targetType, setTargetType] = useState<FullInstitutionType>("company");
  const [displayName, setDisplayName] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Returns whether the upgrade actually navigated, so the blocking screen is dismissed on a
  // rejected upgrade and held through the redirect on a successful one.
  const requestUpgrade = async (): Promise<boolean> => {
    setSubmitting(true);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${institutionSlug}/upgrade`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType,
            displayName: displayName.trim(),
          }),
        },
      );

      if (!response.ok) {
        const code = await readErrorCode(response);
        addToast({
          type: "error",
          message: errorMessageFor(code, UPGRADE_ERROR_COPY, UPGRADE_FALLBACK),
        });
        return false;
      }

      const data = (await response.json()) as UpgradeResponse;
      addToast({
        type: "success",
        message: `Institusi ditingkatkan menjadi ${FULL_INSTITUTION_TYPE_LABELS[data.institutionType]}.`,
      });
      // The slug is re-derived from the official name, so the old URL no longer resolves.
      router.replace(`/institution/${data.slug}`);
      return true;
    } finally {
      setSubmitting(false);
    }
  };

  const submitUpgrade = () =>
    runAndNavigate(requestUpgrade, { message: "Meningkatkan institusi…" });

  const confirmUpgrade = () => {
    const trimmedName = displayName.trim();

    if (trimmedName.length < 2) {
      setNameInvalid(true);
      openModal({
        title: "Nama institusi wajib diisi",
        body: "Masukkan nama resmi institusi yang akan ditampilkan setelah peningkatan.",
        actions: [{ label: "Mengerti", onClick: () => {} }],
      });
      return;
    }

    setNameInvalid(false);
    openModal({
      title: "Tingkatkan institusi ini?",
      body: (
        <div className="stack-sm">
          <p>
            Institusi ini akan menjadi <strong>{FULL_INSTITUTION_TYPE_LABELS[targetType]}</strong>{" "}
            dengan nama <strong>{trimmedName}</strong>.
          </p>
          <p>
            Peningkatan bersifat permanen. Institusi tidak dapat dikembalikan menjadi personal, dan
            tipenya tidak dapat diubah lagi setelah ini.
          </p>
          <p>
            Alamat institusi juga akan berubah mengikuti nama resmi, sehingga tautan lama tidak lagi
            berlaku.
          </p>
        </div>
      ),
      actions: [
        { label: "Batal", variant: "secondary", onClick: () => {} },
        { label: "Tingkatkan", variant: "danger", onClick: () => void submitUpgrade() },
      ],
    });
  };

  return (
    <main className="page-shell app-page institution-upgrade-page">
      <PageHeader
        title="Tingkatkan level institusi"
        description="Ubah institusi personal Anda menjadi institusi resmi agar dapat menyelenggarakan lebih banyak kompetisi, membuka mode tim, dan mengundang staf."
      />

      <section className="content-section institution-upgrade-card">
        {!canUpgrade ? (
          <Feedback tone="warning">
            Peningkatan institusi hanya tersedia untuk penyelenggara terverifikasi. Selesaikan
            verifikasi akun Anda terlebih dahulu.
          </Feedback>
        ) : null}
        <div className="section-heading">
          <div>
            <h2>Peningkatan ini permanen</h2>
          </div>
        </div>

        <p>
          Institusi personal mewakili Anda sebagai perorangan. Setelah ditingkatkan, institusi
          mewakili sebuah badan resmi dan <strong>tidak dapat dikembalikan menjadi personal</strong>
          . Tipe yang sudah dipilih juga tidak dapat diganti setelahnya.
        </p>
        <p>
          Verifikasi dokumen tidak diperlukan untuk meningkatkan institusi. Setelah peningkatan,
          halaman ini berubah menjadi halaman verifikasi dokumen yang bersifat opsional dan hanya
          menambah kredibilitas.
        </p>

        <div className="form-field">
          <SelectField
            id="institution-upgrade-type"
            label="Tipe institusi tujuan"
            value={targetType}
            onChange={(value) => setTargetType(value as FullInstitutionType)}
            options={FULL_TYPE_OPTIONS}
          />
        </div>

        <div className="form-field">
          <FormLabel htmlFor={nameFieldId} required>
            Nama resmi institusi
          </FormLabel>
          <FormInput
            id={nameFieldId}
            type="text"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              if (nameInvalid) setNameInvalid(false);
            }}
            placeholder="Contoh: Yayasan Harapan Nusantara"
            required
            aria-required="true"
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameHintId}
          />
          <span id={nameHintId}>
            <FormHelp>
              Nama ini menggantikan nama personal Anda dan menentukan alamat baru institusi.
            </FormHelp>
          </span>
        </div>

        {!canUpgrade && (
          <span id={blockedNoticeId} className="sr-only">
            Peningkatan institusi hanya tersedia untuk penyelenggara terverifikasi. Selesaikan
            verifikasi akun Anda terlebih dahulu.
          </span>
        )}
      </section>

      <FormActionBar>
        <IconButton
          variant="plain"
          size="back"
          icon="arrow-left"
          label="Kembali"
          onClick={() => router.push(`/institution/${institutionSlug}`)}
        />
        <div className="form-action-bar-end">
          <Button
            type="button"
            disabled={!canUpgrade}
            loading={submitting}
            onClick={confirmUpgrade}
            leadingIcon={<Icon name="building" />}
            aria-describedby={canUpgrade ? undefined : blockedNoticeId}
          >
            Tingkatkan institusi
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
