"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Feedback,
  FormActionBar,
  FormHelp,
  Icon,
  IconButton,
  PageHeader,
  SelectField,
} from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";
// Type-only: importing the enum VALUE would pull the Drizzle schema into the client bundle. The
// exhaustive Record below is the compile-time guarantee instead — a new full subtype fails to build
// until it is given a label here.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";

const TYPE_LABELS: Record<FullInstitutionType, string> = {
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

const FULL_TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({
  value: value as FullInstitutionType,
  label,
}));

type UpgradeResponse = {
  institutionType: FullInstitutionType;
  displayName: string;
  slug: string;
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  if ((await readErrorCode(response.clone())) === SESSION_MISMATCH_CODE) {
    return SESSION_MISMATCH_MESSAGE;
  }
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Peningkatan institusi gagal diproses.";
  } catch {
    return "Peningkatan institusi gagal diproses.";
  }
};

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

  const nameFieldId = useId();
  const nameHintId = `${nameFieldId}-hint`;
  const blockedNoticeId = useId();

  const [targetType, setTargetType] = useState<FullInstitutionType>("company");
  const [displayName, setDisplayName] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submitUpgrade = async () => {
    setSubmitting(true);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${institutionSlug}/upgrade`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetType, displayName: displayName.trim() }),
        },
      );

      if (!response.ok) {
        addToast({ type: "error", message: await extractErrorMessage(response) });
        return;
      }

      const data = (await response.json()) as UpgradeResponse;
      addToast({
        type: "success",
        message: `Institusi ditingkatkan menjadi ${TYPE_LABELS[data.institutionType]}.`,
      });
      // The slug is re-derived from the official name, so the old URL no longer resolves.
      router.replace(`/institution/${data.slug}`);
    } finally {
      setSubmitting(false);
    }
  };

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
            Institusi ini akan menjadi <strong>{TYPE_LABELS[targetType]}</strong> dengan nama{" "}
            <strong>{trimmedName}</strong>.
          </p>
          <p>
            Peningkatan bersifat permanen — institusi tidak dapat dikembalikan menjadi personal, dan
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
        eyebrow="Tingkat institusi"
        title="Tingkatkan level institusi"
        description="Ubah institusi personal Anda menjadi institusi resmi agar dapat menyelenggarakan lebih banyak kompetisi, membuka mode tim, dan mengundang staf."
      />

      <section className="content-section institution-upgrade-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Sebelum melanjutkan</p>
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
          <label htmlFor={nameFieldId} className="form-label form-label-required">
            Nama resmi institusi
          </label>
          <input
            id={nameFieldId}
            type="text"
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              if (nameInvalid) setNameInvalid(false);
            }}
            placeholder="Contoh: Yayasan Harapan Nusantara"
            className="form-input"
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
          <Feedback id={blockedNoticeId} tone="warning">
            Peningkatan institusi hanya tersedia untuk Rekruter Terpercaya. Selesaikan verifikasi
            akun Anda terlebih dahulu.
          </Feedback>
        )}
      </section>

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Panel institusi"
          onClick={() => router.push(`/institution/${institutionSlug}`)}
        />
        <div className="form-action-bar-end">
          <Button
            type="button"
            disabled={submitting || !canUpgrade}
            loading={submitting}
            onClick={confirmUpgrade}
            leadingIcon={<Icon name="building" />}
            aria-describedby={canUpgrade ? undefined : blockedNoticeId}
          >
            {submitting ? "Memproses..." : "Tingkatkan institusi"}
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
