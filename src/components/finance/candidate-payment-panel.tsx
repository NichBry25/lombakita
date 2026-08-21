"use client";

import { ChangeEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Feedback, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { sessionFetch } from "@/lib/session/session-fetch";
import {
  PAYMENT_PROOF_ACCEPT_ATTRIBUTE,
  PAYMENT_PROOF_FORMAT_HINT,
  paymentProofMimeTypeForFileName,
  preValidatePaymentProofFile,
} from "@/lib/finance/payment-proof-file";
import {
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  asSentence,
  derivePaymentDisplayStatus,
  formatFinanceDateTime,
  formatRupiah,
} from "@/lib/finance/payment-display";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import type { PaymentDerivedStatus } from "@/lib/finance/payment-state";
import { describePaymentDeadline, formatTimeRemaining } from "@/lib/finance/payment-deadline";

export type CandidatePaymentPanelProps = {
  expectedUserId: string;
  competitionId: string;
  registrationId: string;
  payment: {
    currency: string;
    grossAmount: number;
    dueAt: string | null;
    deadlineSuspended: boolean;
    status: PaymentDerivedStatus;
    instructions: {
      bankName: string | null;
      accountNumber: string | null;
      accountHolderName: string | null;
      qrisR2Key: string | null;
      instructionsNote: string | null;
    } | null;
    proof: {
      status: ManualPaymentProofStatus;
      submittedAt: string;
      originalFileName: string;
      rejectionReason: string | null;
      resubmissionAllowed: boolean;
    } | null;
    isPayer: boolean;
    canSubmitProof: boolean;
    canResubmitProof: boolean;
  };
};

/**
 * What a candidate owes, where to send it, and what became of their evidence.
 *
 * Rendered ABOVE the document and submission panels on the registration page. It is the only one
 * of the three with a deadline that ENDS the registration when it passes, so it leads.
 *
 * The upload control is WITHHELD rather than rendered and refused wherever the candidate cannot
 * act — a teammate who is not the payer, a settled payment, a rejection the organiser barred. The
 * server refuses those cases too; this decides only what is offered. Both `canSubmitProof` and
 * `canResubmitProof` are computed server-side so this component never re-derives a permission.
 */
export function CandidatePaymentPanel({
  expectedUserId,
  competitionId,
  registrationId,
  payment,
}: CandidatePaymentPanelProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);

  const displayStatus = derivePaymentDisplayStatus(payment);
  const uploadable = payment.canSubmitProof || payment.canResubmitProof;

  const headingId = "payment-panel-heading";
  const instructionsId = "payment-panel-instructions";
  const inputId = "payment-panel-proof-file";

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;

    if (file) {
      const problem = preValidatePaymentProofFile({ name: file.name, size: file.size });
      if (problem) {
        addToast({ type: "error", message: problem });
        event.target.value = "";
        setSelectedFile(null);
        return;
      }
    }

    setSelectedFile(file);
  };

  const uploadProof = async () => {
    if (!selectedFile || uploadBusy) return;

    // Derived from the extension so it matches what the presigned PUT binds. The browser's own
    // `file.type` is empty for several formats and client-controlled in all of them.
    const contentType = paymentProofMimeTypeForFileName(selectedFile.name);
    if (!contentType) {
      addToast({
        type: "error",
        message: `Format tidak didukung. Unggah bukti transfer dalam format ${PAYMENT_PROOF_FORMAT_HINT}.`,
      });
      return;
    }

    const base = `/api/v1/competitions/${competitionId}/registrations/${registrationId}/payment`;
    setUploadBusy(true);

    try {
      const presign = await sessionFetch(expectedUserId, `${base}/upload-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: selectedFile.name }),
      });

      if (!presign.ok) {
        addToast({ type: "error", message: await refusalMessage(presign, "Gagal menyiapkan unggahan. Coba lagi.") });
        return;
      }

      const grant = (await presign.json()) as { uploadUrl: string; r2Key: string };

      const put = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: selectedFile,
      });

      if (!put.ok) {
        addToast({ type: "error", message: "Unggahan ke penyimpanan gagal. Coba lagi." });
        return;
      }

      // POST for a first submission, PUT for a replacement. The two enforce different rules and are
      // deliberately not one upsert: a replacement must pass the organiser's resubmission bar, and
      // the insert path has no bar to respect.
      const record = await sessionFetch(expectedUserId, `${base}/proof`, {
        method: payment.canResubmitProof ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          r2Key: grant.r2Key,
          originalFileName: selectedFile.name,
          fileSizeBytes: selectedFile.size,
          contentType,
        }),
      });

      if (!record.ok) {
        addToast({ type: "error", message: await refusalMessage(record, "Bukti transfer ditolak. Coba lagi.") });
        return;
      }

      addToast({ type: "success", message: "Bukti transfer terkirim. Menunggu verifikasi penyelenggara." });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Pengiriman gagal karena gangguan koneksi." });
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <section className="content-section" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>Pembayaran</h2>
        <span className="status-badge" data-status={PAYMENT_STATUS_TONES[displayStatus]}>
          {PAYMENT_STATUS_LABELS[displayStatus]}
        </span>
      </div>

      <p className="muted-copy">
        Transfer langsung ke rekening penyelenggara, lalu unggah bukti transfernya di sini.
        Lombakita tidak menerima atau menyimpan dana Anda.
      </p>

      <dl className="detail-grid">
        <div>
          <dt>Jumlah</dt>
          <dd className="data-text">{formatRupiah(payment.grossAmount, payment.currency)}</dd>
        </div>
        <PaymentDeadline
        dueAt={payment.dueAt}
        suspended={payment.deadlineSuspended}
        // Read from the LEDGER, not from the proof: the proof can read `verified` for a moment
        // before the event folds, and a deadline is about the money rather than about the evidence.
        settled={payment.status === "succeeded" || payment.status === "refunded"}
      />
      </dl>

      <PaymentInstructions instructions={payment.instructions} id={instructionsId} />

      <PaymentStateNotice payment={payment} />

      {uploadable ? (
        <div className="form-field">
          <label className="form-label" htmlFor={inputId}>
            {payment.canResubmitProof ? "Unggah bukti transfer baru" : "Unggah bukti transfer"}
          </label>
          <div className="pf-media-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              leadingIcon={<Icon name="upload" size="sm" aria-hidden="true" />}
            >
              Pilih berkas
            </Button>
            <span className="form-help">
              {selectedFile ? selectedFile.name : "Belum ada berkas yang dipilih"}
            </span>
          </div>
          <input
            id={inputId}
            ref={fileInputRef}
            type="file"
            accept={PAYMENT_PROOF_ACCEPT_ATTRIBUTE}
            onChange={handleFileSelect}
            className="sr-only"
            aria-describedby={payment.instructions ? instructionsId : undefined}
          />
          <p className="form-help">{PAYMENT_PROOF_FORMAT_HINT} (maks. 10 MB).</p>
          <Button
            type="button"
            disabled={!selectedFile}
            loading={uploadBusy}
            onClick={() => void uploadProof()}
          >
            Kirim bukti transfer
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** The refusal the server gave, or a fallback when it gave none we can read. */
const refusalMessage = async (response: Response, fallback: string): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return payload?.error?.message ?? fallback;
};

/**
 * Where to send the money, as snapshotted when the payment was created.
 *
 * Renders as a definition list rather than prose because the account number is a value the
 * candidate copies digit by digit into a banking app, and a number buried in a sentence is the
 * easiest thing on this page to mistype.
 */
function PaymentInstructions({
  instructions,
  id,
}: {
  instructions: CandidatePaymentPanelProps["payment"]["instructions"];
  id: string;
}) {
  if (!instructions) {
    // A DEFINED STATE, not a blank. A payment whose snapshot is missing predates the snapshot
    // table; the candidate needs to be told to ask rather than left staring at an empty card.
    return (
      <Feedback tone="warning">
        Informasi rekening belum tersedia untuk pembayaran ini. Hubungi penyelenggara sebelum
        melakukan transfer.
      </Feedback>
    );
  }

  const hasBankDetails =
    instructions.bankName !== null ||
    instructions.accountNumber !== null ||
    instructions.accountHolderName !== null;

  return (
    <Card variant="inset" id={id}>
      <h3 className="section-title">Tujuan transfer</h3>

      {hasBankDetails ? (
        <dl className="detail-grid">
          {instructions.bankName ? (
            <div>
              <dt>Bank</dt>
              <dd>{instructions.bankName}</dd>
            </div>
          ) : null}
          {instructions.accountNumber ? (
            <div>
              <dt>Nomor rekening</dt>
              <dd className="data-text">{instructions.accountNumber}</dd>
            </div>
          ) : null}
          {instructions.accountHolderName ? (
            <div>
              <dt>Atas nama</dt>
              <dd>{instructions.accountHolderName}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {instructions.qrisR2Key ? (
        <p className="muted-copy">
          Penyelenggara juga menerima pembayaran melalui QRIS. Pindai kode QRIS yang mereka
          sediakan, lalu unggah bukti transaksinya di sini.
        </p>
      ) : null}

      {instructions.instructionsNote ? (
        <p className="muted-copy">{instructions.instructionsNote}</p>
      ) : null}
    </Card>
  );
}

/**
 * The deadline, and what it currently means.
 *
 * A bare timestamp is not enough on this surface. It cannot say whether the date is tomorrow or
 * next month, and — the case the ruling is about — it cannot say that the deadline has stopped
 * applying because the candidate's evidence is with the organiser. Rendered as a countdown next to
 * a pending proof, a date tells someone who already paid that they are late, which is how a person
 * transfers twice.
 *
 * The instant shown is the payment's own snapshot (DEC-0169). It is never recomputed from the
 * competition's window, so an organiser shortening that window does not move a deadline already
 * promised to someone mid-transfer.
 */
function PaymentDeadline({
  dueAt,
  suspended,
  settled,
}: {
  dueAt: string | null;
  suspended: boolean;
  settled: boolean;
}) {
  const state = describePaymentDeadline(dueAt, { suspended, settled });

  if (state.kind === "none") return null;

  return (
    <div>
      <dt>Batas waktu</dt>
      <dd className="stack-xs">
        <time dateTime={state.dueAt} className="data-text">
          {formatFinanceDateTime(state.dueAt)}
        </time>
        {state.kind === "settled" ? (
          <span className="form-help">
            Tidak berlaku lagi — pembayaran ini sudah selesai.
          </span>
        ) : state.kind === "suspended" ? (
          <span className="form-help">
            Tidak berlaku selama bukti transfer Anda ditinjau — pendaftaran Anda tidak akan
            dibatalkan karena batas waktu ini.
          </span>
        ) : state.kind === "passed" ? (
          <span className="form-help">Batas waktu sudah lewat.</span>
        ) : (
          <span className={state.urgent ? "status-badge" : "form-help"} data-status={state.urgent ? "closing" : undefined}>
            {formatTimeRemaining(state.remainingMs)}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * What the candidate needs to know about the current state, as page content rather than a toast.
 *
 * A rejection reason is the instruction the candidate works from, so it has to survive a reload —
 * that is precisely the case a toast cannot serve.
 */
function PaymentStateNotice({ payment }: { payment: CandidatePaymentPanelProps["payment"] }) {
  if (!payment.isPayer) {
    return (
      <Feedback tone="info">
        Pembayaran tim ini ditangani oleh ketua tim. Anda dapat memantau statusnya di sini.
      </Feedback>
    );
  }

  // "secara otomatis" is load-bearing: nobody decided this. The organiser did not reject the
  // candidate and the candidate did not withdraw, and a cancellation with no visible author reads
  // as one of those two. The re-registration line states what `createIndividualRegistration`
  // actually does — it refuses on ANY existing row, cancelled included — because the previous copy
  // promised a way back that the service does not provide.
  if (payment.status === "expired") {
    return (
      <Feedback tone="error">
        Batas waktu pembayaran telah lewat, sehingga pendaftaran ini dibatalkan secara otomatis.
        Pendaftaran ulang untuk kompetisi ini belum tersedia — hubungi penyelenggara jika Anda
        sudah melakukan transfer.
      </Feedback>
    );
  }

  if (payment.status === "succeeded") {
    return <Feedback tone="success">Pembayaran Anda sudah diverifikasi penyelenggara.</Feedback>;
  }

  if (!payment.proof) return null;

  if (payment.proof.status === "pending_review") {
    return (
      <Feedback tone="info">
        Bukti transfer Anda sedang ditinjau penyelenggara. Anda tidak perlu melakukan apa pun.
      </Feedback>
    );
  }

  if (payment.proof.status === "rejected") {
    // BOTH BRANCHES NAME THE DEADLINE, and the barred one needs it more.
    //
    // A rejection resumes the clock — only `pending_review` suspends it — so a candidate here is
    // running out of time in either branch. In the barred branch they also cannot cancel (a proof
    // exists, so that affordance is withheld) and cannot resubmit, which leaves contacting the
    // organiser as the only action they have and the deadline as the only thing still moving.
    // Saying "hubungi penyelenggara" without saying by when is an instruction with no urgency
    // attached to the one state that has the most.
    return (
      <Feedback tone={payment.proof.resubmissionAllowed ? "warning" : "error"}>
        {payment.proof.resubmissionAllowed
          ? `Bukti transfer ditolak. Alasan: ${asSentence(payment.proof.rejectionReason ?? "—")} Unggah bukti yang baru sebelum batas waktu.`
          : `Bukti transfer ditolak dan tidak dapat dikirim ulang. Alasan: ${asSentence(payment.proof.rejectionReason ?? "—")} Hubungi penyelenggara sebelum batas waktu di atas — jika terlewat, pendaftaran ini dibatalkan secara otomatis.`}
      </Feedback>
    );
  }

  return null;
}
