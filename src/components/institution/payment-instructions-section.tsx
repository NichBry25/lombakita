"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  ButtonLink,
  Feedback,
  FormInput,
  FormLabel,
  FormLabelText,
  FormTextarea,
  Icon,
  Skeleton,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";
import { QRIS_FORMAT_HINT, QRIS_MAX_BYTES, qrisMimeTypeForFileName } from "@/lib/finance/qris-file";
import { formatFileSize } from "@/lib/text/format-file-size";

type RefusalAction = "grant" | "save";

const PAYMENT_INSTRUCTIONS_ERROR_COPY: Partial<Record<string, string>> = {
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
  forbidden: "Hanya pemilik institusi yang dapat mengatur informasi pembayaran.",
  payment_instructions_qris_format_unsupported: `Format tidak didukung. Gunakan ${QRIS_FORMAT_HINT}.`,
  payment_instructions_upload_unavailable:
    "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
  payment_instructions_incomplete:
    "Isi nama bank, nomor rekening, dan nama pemilik rekening, atau unggah QRIS.",
  payment_instructions_qris_key_invalid: "Berkas QRIS tidak valid. Unggah ulang QRIS lalu simpan.",
  payment_instructions_blocked_trust_removed:
    "Status tepercaya akun Anda dicabut staf, jadi informasi pembayaran tidak dapat Anda ubah.",
};

const REFUSAL_FALLBACK: Record<RefusalAction, string> = {
  grant: "QRIS gagal diunggah. Coba lagi.",
  save: "Informasi pembayaran gagal disimpan. Coba lagi.",
};

type Instructions = {
  bankName: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  qrisR2Key: string | null;
  instructionsNote: string | null;
};

const EMPTY: Instructions = {
  bankName: "",
  accountNumber: "",
  accountHolderName: "",
  qrisR2Key: null,
  instructionsNote: "",
};

/**
 * Where this institution wants to be paid.
 *
 * An independent sub-form with its own Save at its own foot, per the form standards: it saves to a
 * different endpoint from the identity form above it and must not be swept up by the page's global
 * Save.
 *
 * The one thing this surface has to communicate, and the reason its copy leads with it: the money
 * never touches Lombakita. These are the institution's own account details, republished verbatim to
 * every payer, and a digit wrong here sends real transfers to an account nobody is watching. The
 * platform cannot detect that, because it never sees the money, so the accuracy of this form is the
 * check there is.
 */
export function PaymentInstructionsSection({
  institutionSlug,
  expectedUserId,
}: {
  institutionSlug: string;
  expectedUserId: string;
}) {
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<Instructions>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const base = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/payment-instructions`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { credentials: "include" });
      if (!response.ok) return;

      const { instructions } = (await response.json()) as { instructions: Instructions | null };
      // An institution with no row yet is a normal state, not an error: it simply has not said
      // where to send money, which is exactly what this form is for.
      if (instructions) {
        setForm({
          bankName: instructions.bankName ?? "",
          accountNumber: instructions.accountNumber ?? "",
          accountHolderName: instructions.accountHolderName ?? "",
          qrisR2Key: instructions.qrisR2Key,
          instructionsNote: instructions.instructionsNote ?? "",
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (field: keyof Instructions) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const uploadQris = async (file: File) => {
    // Both checks are repeated on the server. They run here as well so the organiser is told before
    // a file leaves their machine, rather than after an upload that was always going to be refused.
    if (qrisMimeTypeForFileName(file.name) === null) {
      addToast({ type: "error", message: `Format tidak didukung. Gunakan ${QRIS_FORMAT_HINT}.` });
      return;
    }
    if (file.size > QRIS_MAX_BYTES) {
      addToast({
        type: "error",
        message: `Berkas terlalu besar (${formatFileSize(file.size)}). Maksimal ${formatFileSize(QRIS_MAX_BYTES)}.`,
      });
      return;
    }

    setIsUploading(true);
    try {
      const grantResponse = await sessionFetch(expectedUserId, `${base}/qris-upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name }),
      });

      if (!grantResponse.ok) {
        const code = await readErrorCode(grantResponse);
        addToast({
          type: "error",
          message: errorMessageFor(code, PAYMENT_INSTRUCTIONS_ERROR_COPY, REFUSAL_FALLBACK.grant),
        });
        return;
      }

      const grant = (await grantResponse.json()) as {
        uploadUrl: string;
        r2Key: string;
        contentType: string;
      };

      const put = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": grant.contentType },
        body: file,
      });

      if (!put.ok) {
        addToast({ type: "error", message: "QRIS gagal diunggah ke penyimpanan." });
        return;
      }

      // Held in form state, not saved yet. The key becomes this institution's published QRIS only
      // when the organiser saves, so an upload they change their mind about is simply never used.
      setForm((prev) => ({ ...prev, qrisR2Key: grant.r2Key }));
      addToast({ type: "success", message: "QRIS terunggah. Simpan untuk menerapkannya." });
    } catch {
      addToast({ type: "error", message: "QRIS gagal diunggah karena gangguan koneksi." });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    setIsSaving(true);

    try {
      const response = await sessionFetch(expectedUserId, base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const code = await readErrorCode(response);
        addToast({
          type: "error",
          message: errorMessageFor(code, PAYMENT_INSTRUCTIONS_ERROR_COPY, REFUSAL_FALLBACK.save),
        });
        return;
      }

      addToast({ type: "success", message: "Informasi pembayaran disimpan." });
    } catch {
      addToast({
        type: "error",
        message: "Informasi pembayaran gagal disimpan karena gangguan koneksi.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <section className="content-section">
        <div className="stack-md" aria-label="Memuat informasi pembayaran">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
        </div>
      </section>
    );
  }

  // The server refuses missing bank details only when no QRIS is on file.
  const bankDetailsRequired = form.qrisR2Key === null;

  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <h2>Informasi pembayaran</h2>
        </div>
      </div>

      <Feedback tone="warning" lead="Periksa nomor rekening sebelum menyimpan.">
        Dana peserta masuk langsung ke rekening ini, dan transfer ke rekening yang salah tidak dapat
        ditarik kembali.
        <div>
          <ButtonLink variant="link" size="sm" href="/syarat-ketentuan#biaya-pendaftaran">
            Baca ketentuan pembayaran
          </ButtonLink>
        </div>
      </Feedback>

      <p className="muted-copy">
        Isi rekening bank, unggah QRIS, atau keduanya. Kompetisi berbayar hanya dapat dibuka setelah
        salah satunya terisi.
      </p>

      <form className="stack-md" onSubmit={save}>
        <div className="form-field">
          <FormLabel
            htmlFor="pi-bank-name"
            required={bankDetailsRequired}
            optional={!bankDetailsRequired}
          >
            Nama bank
          </FormLabel>
          <FormInput
            id="pi-bank-name"
            value={form.bankName ?? ""}
            maxLength={120}
            placeholder="Bank Mandiri"
            onChange={(event) => update("bankName")(event.target.value)}
          />
        </div>

        <div className="form-field">
          <FormLabel
            htmlFor="pi-account-number"
            required={bankDetailsRequired}
            optional={!bankDetailsRequired}
          >
            Nomor rekening
          </FormLabel>
          <FormInput
            id="pi-account-number"
            // `inputMode` rather than `type="number"`: an account number is a digit STRING, and a
            // numeric input drops leading zeros and offers a spinner that can silently change it.
            inputMode="numeric"
            value={form.accountNumber ?? ""}
            maxLength={40}
            placeholder="1370012345678"
            onChange={(event) => update("accountNumber")(event.target.value)}
          />
          <p className="form-help">Tulis tanpa spasi atau tanda hubung.</p>
        </div>

        <div className="form-field">
          <FormLabel
            htmlFor="pi-account-holder"
            required={bankDetailsRequired}
            optional={!bankDetailsRequired}
          >
            Nama pemilik rekening
          </FormLabel>
          <FormInput
            id="pi-account-holder"
            value={form.accountHolderName ?? ""}
            maxLength={160}
            placeholder="Yayasan Seed Academy"
            onChange={(event) => update("accountHolderName")(event.target.value)}
          />
          <p className="form-help">
            Harus sama persis dengan nama pada rekening, agar peserta yakin tidak salah tujuan.
          </p>
        </div>

        {/* The same upload row every other file field in the app uses: a button that opens the
            picker, the current selection beside it, and the native input kept out of sight. A bare
            `<input type="file">` wearing `.form-input` renders the browser's own control, which is
            the one thing no other control on this page does. */}
        <div className="form-field">
          <FormLabelText id="pi-qris-label" optional>
            QRIS
          </FormLabelText>
          <div className="pf-media-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={isUploading}
              onClick={() => fileInputRef.current?.click()}
              leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
            >
              Pilih berkas
            </Button>
            <span className="form-help">
              {form.qrisR2Key
                ? "QRIS tersimpan. Pilih berkas baru untuk menggantinya."
                : "Belum ada QRIS."}
            </span>
          </div>
          <input
            ref={fileInputRef}
            id="pi-qris"
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-labelledby="pi-qris-label"
            disabled={isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadQris(file);
            }}
          />
          <p className="form-help">
            {`${QRIS_FORMAT_HINT}, maks ${formatFileSize(QRIS_MAX_BYTES)}. Unggah gambar utuh, karena QRIS yang terpotong tidak dapat dipindai.`}
          </p>
        </div>

        <div className="form-field">
          <FormLabel htmlFor="pi-note" optional>
            Catatan untuk peserta
          </FormLabel>
          <FormTextarea
            id="pi-note"
            rows={3}
            value={form.instructionsNote ?? ""}
            maxLength={500}
            placeholder="Cantumkan nama lengkap dan nama kompetisi pada berita transfer."
            onChange={(event) => update("instructionsNote")(event.target.value)}
          />
        </div>

        <div className="cluster">
          <Button type="submit" loading={isSaving} leadingIcon={<Icon name="save" />}>
            Simpan informasi pembayaran
          </Button>
        </div>
      </form>
    </section>
  );
}
