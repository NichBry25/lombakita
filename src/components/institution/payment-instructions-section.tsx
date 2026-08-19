"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Feedback, Icon, Skeleton } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { sessionFetch } from "@/lib/session/session-fetch";
import { QRIS_FORMAT_HINT, QRIS_MAX_BYTES, qrisMimeTypeForFileName } from "@/lib/finance/qris-file";
import { formatFileSize } from "@/lib/text/format-file-size";

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
 * platform cannot detect that — it never sees the money — so the accuracy of this form is the only
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

  const refusalMessage = async (response: Response, fallback: string): Promise<string> => {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    return payload?.error?.message ?? fallback;
  };

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
        addToast({
          type: "error",
          message: await refusalMessage(grantResponse, "QRIS gagal diunggah."),
        });
        return;
      }

      const grant = (await grantResponse.json()) as { uploadUrl: string; r2Key: string; contentType: string };

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
      // when the organiser saves — so an upload they change their mind about is simply never used.
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
        addToast({
          type: "error",
          message: await refusalMessage(response, "Informasi pembayaran gagal disimpan."),
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

  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <h2>Informasi pembayaran</h2>
        </div>
      </div>

      <Feedback tone="warning">
        Dana peserta masuk langsung ke rekening lembaga Anda — Lombakita tidak menampung dana.
        Periksa setiap digit: nomor rekening yang keliru mengirim transfer peserta ke rekening yang
        salah, dan platform tidak dapat menariknya kembali.
      </Feedback>

      <p className="muted-copy">
        Isi rekening bank, unggah QRIS, atau keduanya. Kompetisi berbayar hanya dapat dibuka setelah
        salah satunya terisi.
      </p>

      <form className="stack-md" onSubmit={save}>
        <div className="form-field">
          <label className="form-label" htmlFor="pi-bank-name">
            Nama bank
          </label>
          <input
            id="pi-bank-name"
            className="form-input"
            value={form.bankName ?? ""}
            maxLength={120}
            placeholder="Bank Mandiri"
            onChange={(event) => update("bankName")(event.target.value)}
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pi-account-number">
            Nomor rekening
          </label>
          <input
            id="pi-account-number"
            className="form-input"
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
          <label className="form-label" htmlFor="pi-account-holder">
            Nama pemilik rekening
          </label>
          <input
            id="pi-account-holder"
            className="form-input"
            value={form.accountHolderName ?? ""}
            maxLength={160}
            placeholder="Yayasan Seed Academy"
            onChange={(event) => update("accountHolderName")(event.target.value)}
          />
          <p className="form-help">
            Harus sama persis dengan nama pada rekening, agar peserta yakin tidak salah tujuan.
          </p>
        </div>

        <div className="form-field">
          <span className="form-label">QRIS</span>
          {form.qrisR2Key ? (
            <p className="muted-copy">
              <Icon name="check" size="sm" aria-hidden="true" /> QRIS tersimpan. Unggah berkas baru
              untuk menggantinya.
            </p>
          ) : (
            <p className="muted-copy">Belum ada QRIS.</p>
          )}
          <input
            ref={fileInputRef}
            id="pi-qris"
            className="form-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Unggah berkas QRIS"
            disabled={isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadQris(file);
            }}
          />
          <p className="form-help">
            {`${QRIS_FORMAT_HINT} · maks ${formatFileSize(QRIS_MAX_BYTES)}. Unggah gambar utuh — QRIS yang terpotong tidak dapat dipindai.`}
          </p>
          {isUploading ? <p className="form-help">Mengunggah QRIS…</p> : null}
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="pi-note">
            Catatan untuk peserta
          </label>
          <textarea
            id="pi-note"
            className="form-input"
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
