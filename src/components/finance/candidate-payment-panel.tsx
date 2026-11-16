"use client";

import { ChangeEvent, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Feedback, FormLabel, Icon, Panel } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { AssentNotice } from "@/components/legal/assent-notice";
import { errorMessageFor } from "@/lib/errors/error-copy";
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
  formatRupiah,
} from "@/lib/finance/payment-display";
import type { ManualPaymentProofStatus } from "@/lib/finance/payment-model";
import type { PaymentDerivedStatus } from "@/lib/finance/payment-state";
import {
  describePaymentDeadline,
  formatTimeRemaining,
  type PaymentDeadlineState,
} from "@/lib/finance/payment-deadline";

type SurfaceCopy = Partial<Record<string, string>>;

const PAYMENT_PROOF_ERROR_COPY: SurfaceCopy = {
  forbidden: "Akun Anda bukan akun kandidat. Masuk dengan akun kandidat untuk melanjutkan.",
  manual_proof_payment_not_found: "Pembayaran tidak ditemukan. Muat ulang halaman.",
  manual_proof_resubmission_barred: "Bukti transfer ini tidak dapat dikirim ulang.",
  manual_proof_not_manual_lane: "Hanya pembayaran transfer manual yang menerima bukti transfer.",
  manual_proof_object_missing:
    "Berkas bukti transfer belum selesai diunggah. Silakan unggah ulang.",
  manual_proof_registration_cancelled:
    "Pendaftaran ini sudah dibatalkan, sehingga bukti transfer tidak dapat diproses.",
  manual_proof_lane_closed:
    "Pembayaran ini sudah selesai, sehingga bukti transfer tidak dapat diproses.",
  manual_proof_already_submitted:
    "Pembayaran ini sudah memiliki bukti transfer. Muat ulang halaman untuk mengirim ulang.",
  manual_proof_not_found: "Belum ada bukti transfer untuk dikirim ulang.",
  manual_proof_upload_unavailable: "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
};

const PAYMENT_PROOF_UPLOAD_URL_ERROR_COPY: SurfaceCopy = {
  ...PAYMENT_PROOF_ERROR_COPY,
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
  manual_proof_object_key_invalid: `Format tidak didukung. Unggah bukti transfer dalam format ${PAYMENT_PROOF_FORMAT_HINT}.`,
};

const PAYMENT_PROOF_RECORD_ERROR_COPY: SurfaceCopy = {
  ...PAYMENT_PROOF_ERROR_COPY,
  manual_proof_object_key_invalid:
    "Berkas bukti transfer tidak valid. Pilih berkas lain lalu unggah ulang.",
};

const PAYMENT_PROOF_UPLOAD_URL_FALLBACK = "Gagal menyiapkan unggahan. Coba lagi.";
const PAYMENT_PROOF_RECORD_FALLBACK = "Gagal mengirim bukti transfer. Coba lagi.";

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
      qris:
        | { kind: "none" }
        | { kind: "hidden" }
        | { kind: "unavailable" }
        | { kind: "shown"; url: string };
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
 * act: a teammate who is not the payer, a settled payment, a rejection the organiser barred. The
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
        addToast({
          type: "error",
          message: await refusalMessage(
            presign,
            PAYMENT_PROOF_UPLOAD_URL_ERROR_COPY,
            PAYMENT_PROOF_UPLOAD_URL_FALLBACK,
          ),
        });
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
        addToast({
          type: "error",
          message: await refusalMessage(
            record,
            PAYMENT_PROOF_RECORD_ERROR_COPY,
            PAYMENT_PROOF_RECORD_FALLBACK,
          ),
        });
        return;
      }

      addToast({
        type: "success",
        message: "Bukti transfer terkirim. Menunggu verifikasi penyelenggara.",
      });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Pengiriman gagal karena gangguan koneksi." });
    } finally {
      setUploadBusy(false);
    }
  };

  // Resolved once, read twice: the pill above and the row below have to agree, and computing it in
  // two places is how they stop agreeing.
  //
  // `settled` comes from the LEDGER, not from the proof. The proof can read `verified` for a moment
  // before the event folds, and a deadline is about the money rather than about the evidence.
  const deadline = describePaymentDeadline(payment.dueAt, {
    suspended: payment.deadlineSuspended,
    settled: payment.status === "succeeded" || payment.status === "refunded",
  });

  return (
    <section className="content-section" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>Pembayaran</h2>
        {/* THE PILL IS ABOUT TIME WHENEVER TIME IS RUNNING. A countdown is the one fact on this
            panel that changes on its own, and it belongs where the reader already looks for the
            state of the thing. When the clock is stopped there is nothing to count, so the pill
            falls back to the status it always showed. */}
        {deadline.kind === "remaining" ? (
          <span className="status-badge" data-status={deadline.urgent ? "closing" : "open"}>
            {formatTimeRemaining(deadline.remainingMs)}
          </span>
        ) : (
          <span className="status-badge" data-status={PAYMENT_STATUS_TONES[displayStatus]}>
            {PAYMENT_STATUS_LABELS[displayStatus]}
          </span>
        )}
      </div>

      {/* The instruction is only true while the control it describes is on the page. On a settled
          or expired payment it told the candidate to transfer and upload three lines above the
          Keterangan row saying the deadline no longer applies, with no upload control between
          them. Gated on `uploadable`, the same condition the control itself uses. */}
      {uploadable ? (
        <p className="muted-copy">
          Transfer langsung ke rekening penyelenggara, lalu unggah bukti transfernya di sini.
        </p>
      ) : null}

      <dl className="detail-grid">
        <div>
          <dt>Jumlah</dt>
          <dd className="data-text">{formatRupiah(payment.grossAmount, payment.currency)}</dd>
        </div>
        <PaymentDeadline deadline={deadline} />
      </dl>

      <PaymentInstructions
        instructions={payment.instructions}
        canResubmitProof={payment.canResubmitProof}
        id={instructionsId}
      />

      <PaymentStateNotice payment={payment} />

      {uploadable ? (
        <div className="form-field">
          <FormLabel htmlFor={inputId} required>
            {payment.canResubmitProof ? "Unggah bukti transfer baru" : "Unggah bukti transfer"}
          </FormLabel>
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
          {/* ABOVE the send control, not below it. This is the last thing a candidate reads
              before committing money they cannot get back on their own initiative, so it has to
              be on screen at the moment they decide rather than under the button they already
              pressed. */}
          <AssentNotice withPaymentTerms />
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

/** This panel's sentence for the refusal's code, or the action's fallback. */
const refusalMessage = async (
  response: Response,
  surfaceCopy: SurfaceCopy,
  fallback: string,
): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return errorMessageFor(payload?.error?.code, surfaceCopy, fallback);
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
  canResubmitProof,
  id,
}: {
  instructions: CandidatePaymentPanelProps["payment"]["instructions"];
  canResubmitProof: boolean;
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

  const showsQris = instructions.qris.kind === "shown" || instructions.qris.kind === "unavailable";

  // No heading over nothing: a QRIS-only snapshot that the viewer may not scan has no content here.
  if (!hasBankDetails && !showsQris && !instructions.instructionsNote) return null;

  return (
    <Panel id={id} className="stack-sm">
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

      {instructions.qris.kind === "shown" ? (
        <QrisCode
          key={instructions.qris.url}
          url={instructions.qris.url}
          canResubmitProof={canResubmitProof}
          hasBankDetails={hasBankDetails}
        />
      ) : null}

      {instructions.qris.kind === "unavailable" ? (
        <QrisUnavailableLine hasBankDetails={hasBankDetails} />
      ) : null}

      {instructions.instructionsNote ? (
        <p className="muted-copy">{instructions.instructionsNote}</p>
      ) : null}
    </Panel>
  );
}

/**
 * The organiser's QRIS on a fixed white plate, and the sentence that points at it.
 *
 * The plate stays white in both themes because a transparent QRIS is black modules on nothing, and
 * a phone camera cannot read that against a dark surface. The image loads eagerly: the link lives
 * an hour, and a deferred request made after that would break.
 *
 * An image that fails, whether after the page is interactive or before it, becomes the unavailable
 * line. Signing never checks that the object exists, so a missing object still gets a valid link.
 */
function QrisCode({
  url,
  canResubmitProof,
  hasBankDetails,
}: {
  url: string;
  canResubmitProof: boolean;
  hasBankDetails: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  // The error event of an image that failed before hydration has already fired and is not replayed,
  // so the element is checked when it is attached.
  const failIfAlreadyBroken = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0) {
      setImageFailed(true);
    }
  }, []);

  if (imageFailed) return <QrisUnavailableLine hasBankDetails={hasBankDetails} />;

  return (
    <>
      <div className="qris-plate">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={failIfAlreadyBroken}
          src={url}
          alt="Kode QRIS penyelenggara"
          loading="eager"
          onError={() => setImageFailed(true)}
        />
      </div>
      <p className="muted-copy">
        {canResubmitProof
          ? "Jika Anda sudah membayar, jangan membayar lagi. Cukup unggah bukti yang baru."
          : "Pindai kode QRIS di atas, lalu unggah bukti transaksinya di sini."}
      </p>
    </>
  );
}

function QrisUnavailableLine({ hasBankDetails }: { hasBankDetails: boolean }) {
  return (
    <p className="muted-copy">
      {hasBankDetails
        ? "Kode QRIS tidak dapat ditampilkan. Silakan transfer ke rekening di atas atau hubungi penyelenggara."
        : "Kode QRIS tidak dapat ditampilkan. Silakan hubungi penyelenggara."}
    </p>
  );
}

/**
 * The deadline, and what it currently means.
 *
 * A bare timestamp is not enough on this surface. It cannot say whether the date is tomorrow or
 * next month, and (the case the ruling is about) it cannot say that the deadline has stopped
 * applying because the candidate's evidence is with the organiser. Rendered as a countdown next to
 * a pending proof, a date tells someone who already paid that they are late, which is how a person
 * transfers twice.
 *
 * The instant shown is the payment's own snapshot (DEC-0169). It is never recomputed from the
 * competition's window, so an organiser shortening that window does not move a deadline already
 * promised to someone mid-transfer.
 */
function PaymentDeadline({ deadline }: { deadline: PaymentDeadlineState }) {
  if (deadline.kind === "none") return null;

  // A NAMED ROW, not a loose line. The note used to hang under the date with nothing to attach it
  // to, so it read as a stray sentence in the middle of a list of labelled values. `Keterangan` is
  // the same dt/dd shape as every other row here, which is what puts it back in the table.
  const note =
    deadline.kind === "settled"
      ? "Tidak berlaku lagi, pembayaran ini sudah selesai."
      : deadline.kind === "suspended"
        ? "Tidak berlaku selama bukti transfer Anda ditinjau. Pendaftaran Anda tidak akan dibatalkan karena batas waktu ini."
        : deadline.kind === "passed"
          ? "Batas waktu sudah lewat."
          : null;

  return (
    <>
      <div>
        <dt>Batas waktu</dt>
        <dd>
          <span className="data-text">
            <LocalDate value={deadline.dueAt} format="financeDateTime" />
          </span>
        </dd>
      </div>
      {note ? (
        <div>
          <dt>Keterangan</dt>
          <dd>{note}</dd>
        </div>
      ) : null}
    </>
  );
}

/**
 * What the candidate needs to know about the current state, as page content rather than a toast.
 *
 * A rejection reason is the instruction the candidate works from, so it has to survive a reload.
 * That is precisely the case a toast cannot serve.
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
  // as one of those two. Whether the person may register again is the registration card's answer,
  // not this message's: the panel cannot tell an individual payment from a team captain's.
  if (payment.status === "expired") {
    return (
      <Feedback tone="error">
        Batas waktu pembayaran telah lewat, sehingga pendaftaran ini dibatalkan secara otomatis.
        Jika Anda sudah melakukan transfer, hubungi penyelenggara.
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
    // A rejection resumes the clock, because only `pending_review` suspends it. A candidate here is
    // running out of time in either branch. In the barred branch they also cannot cancel (a proof
    // exists, so that affordance is withheld) and cannot resubmit, which leaves contacting the
    // organiser as the only action they have and the deadline as the only thing still moving.
    // Saying "hubungi penyelenggara" without saying by when is an instruction with no urgency
    // attached to the one state that has the most.
    return (
      <Feedback tone={payment.proof.resubmissionAllowed ? "warning" : "error"}>
        {payment.proof.resubmissionAllowed
          ? `Bukti transfer ditolak. Alasan: ${asSentence(payment.proof.rejectionReason ?? "—")} Unggah bukti yang baru sebelum batas waktu.`
          : `Bukti transfer ditolak dan tidak dapat dikirim ulang. Alasan: ${asSentence(payment.proof.rejectionReason ?? "—")} Hubungi penyelenggara sebelum batas waktu di atas. Jika terlewat, pendaftaran ini dibatalkan secara otomatis.`}
      </Feedback>
    );
  }

  return null;
}
