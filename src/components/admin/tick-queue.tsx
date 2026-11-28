"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  Card,
  DetailList,
  EmptyState,
  Feedback,
  FormError,
  FormField,
  FormLabel,
  FormLabelText,
  FormTextarea,
  FormTextareaWithLimit,
  Skeleton,
  Table,
  focusFirstInvalidField,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { useModal, useModalTask, useToast, type ModalOutcome } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import { NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { formatRupiah } from "@/lib/finance/payment-display";
import { INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";
import {
  resolveVerificationRefusalMessage,
  VERIFICATION_REFUSAL_COPY,
} from "@/lib/institutions/verification-refusal-copy";
import { INSTITUTION_VERIFICATION_STATUS_LABELS } from "@/lib/institutions/verification-status-labels";
import { formatDisplayToken } from "@/lib/text/capitalize";
import type { InstitutionType, InstitutionVerificationStatus } from "@/server/db/schema";
import { DOCUMENT_TYPE_LABELS } from "@/server/institution-verification/verification-requirements";

// The tick queue as its route answers it. JSON carries the dates as ISO strings.
export type TickQueueClosureItem = { cause: "staff" | "automatic"; closedInstitutionId: string };

export type TickRequestItem = {
  submissionId: string;
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  requestedPath: "instagram" | "documents";
  instagramUrl: string | null;
  pageUrl: string;
  submittedByUserId: string;
  submitterEmail: string | null;
  submitterWouldBeTrusted: boolean;
  submittedAt: string;
  overdue: boolean;
  documentCount: number;
  closure: TickQueueClosureItem | null;
  lastLeftVerified: {
    toStatus: InstitutionVerificationStatus;
    reason: string | null;
    actorUserId: string | null;
    createdAt: string;
  } | null;
  siblingClosures: TickQueueClosureItem[];
};

export type TickNameCheckItem = {
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  tickDomain: string | null;
  ownerEmailDomains: string[];
  paidDraft: {
    competitionId: string;
    title: string;
    feeAmount: number;
    feeCurrency: string | null;
  };
  since: string;
  siblingClosures: TickQueueClosureItem[];
};

export type TickProofItem = {
  institutionId: string;
  institutionSlug: string;
  institutionDisplayName: string;
  nameProofDueAt: string;
  reminded: boolean;
};

export type TickQueueItems = {
  requests: TickRequestItem[];
  nameChecks: TickNameCheckItem[];
  runningProofs: TickProofItem[];
};

type SubmissionStatus = "pending_review" | "approved" | "rejected";

type DocumentRecord = {
  id: string;
  documentType: string;
  r2Key: string;
  originalFileName: string;
  fileSizeBytes: number;
  contentType: string;
};

type SubmissionDetail = {
  id: string;
  institutionSlug: string;
  institutionDisplayName: string;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: SubmissionStatus;
  emailDomainFlag: boolean | null;
  reviewerNotes: string | null;
  submittedAt: string;
  documents: DocumentRecord[];
};

type QueueState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: TickQueueItems };

type DecisionRequest = {
  url: string;
  method: "POST" | "PATCH";
  body: unknown;
  successMessage: string;
  fallback: string;
};

const QUEUE_URL = "/api/platform-ops/tick-queue";
const SUBMISSION_URL = "/api/platform-ops/verification/submissions";
const NAME_CHECK_URL = "/api/platform-ops/institutions";
const VERIFY_URL = "/api/admin/institutions";

// The name check route caps a reason at 1000 characters.
const REASON_MAX_LENGTH = 1000;

const NAME_OK_FORM_ID = "tick-name-ok-form";
const REQUIRE_PROOF_FORM_ID = "tick-require-proof-form";
const REVOKE_FORM_ID = "tick-revoke-form";
const REASON_FIELD_ID = "tick-reason";
const REASON_ERROR_ID = "tick-reason-error";

const REASON_REQUIRED_MESSAGE = VERIFICATION_REFUSAL_COPY.verification_reason_required;

const QUEUE_LOAD_FALLBACK = "Gagal memuat antrean verifikasi.";
const QUEUE_LOAD_NETWORK_MESSAGE = "Terjadi kesalahan.";
const DETAIL_LOAD_FALLBACK = "Gagal memuat detail pengajuan.";
const DETAIL_LOAD_NETWORK_MESSAGE = "Terjadi kesalahan saat memuat detail.";
const DECISION_NETWORK_MESSAGE = "Terjadi kesalahan saat memproses keputusan.";

const DECISION_FALLBACK: Record<"approved" | "rejected", string> = {
  approved: "Pengajuan gagal disetujui. Coba lagi.",
  rejected: "Pengajuan gagal ditolak. Coba lagi.",
};

const NAME_OK_FALLBACK = "Nama gagal ditandai sesuai. Coba lagi.";
const REQUIRE_PROOF_FALLBACK = "Bukti nama gagal diminta. Coba lagi.";
const REVOKE_FALLBACK = "Centang gagal dicabut. Coba lagi.";

const APPROVED_TRUSTED_MESSAGE =
  "Disetujui. Ruang kerja ini kini mendapat centang dan pengirimnya tepercaya.";
const APPROVED_MESSAGE = "Disetujui. Ruang kerja ini kini mendapat centang.";
const TURNED_DOWN_MESSAGE = "Permintaan ditolak dan keluar dari antrean.";
const NAME_OK_MESSAGE = "Nama ditandai sesuai.";
const REQUIRE_PROOF_MESSAGE = "Bukti nama diminta. Batasnya 28 hari dari sekarang.";
const REVOKE_MESSAGE = "Centang dicabut.";

const NAME_OK_SENTENCE = "Centang tetap ada, dan kompetisi berbayar ruang kerja ini dapat tayang.";
const REQUIRE_PROOF_SENTENCE =
  "Pemilik punya 28 hari untuk mengirim bukti nama lewat dokumen. Jika tidak ada bukti, centang hilang pada hari ke-29.";
const REVOKE_SENTENCE =
  "Ruang kerja ini kehilangan centang dan hanya bisa mendapatkannya lagi lewat dokumen.";

const TRUSTED_ON_APPROVAL_NOTE = "Jika disetujui, pengirim juga menjadi penyelenggara tepercaya.";
const NOT_TRUSTED_ON_APPROVAL_NOTE = "Persetujuan ini tidak membuat pengirim menjadi tepercaya.";
const LAST_LEFT_VERIFIED_HEADING = "Terakhir kehilangan centang";
const SIBLING_CLOSED_BY_STAFF =
  "Ruang kerja lain milik pemilik yang sama dicabut centangnya oleh staf.";
const SIBLING_CLOSED_AUTOMATICALLY =
  "Ruang kerja lain milik pemilik yang sama kehilangan centang secara otomatis.";

const DOCUMENT_COLUMNS: readonly TableColumn[] = [
  { key: "type", header: "Tipe", kind: "name" },
  { key: "fileName", header: "Nama file", kind: "text" },
  { key: "format", header: "Format", kind: "text" },
];

const queueStateOf = (items: TickQueueItems | null): QueueState => {
  if (items === null) return { status: "failed" };
  return { status: "ready", items };
};

// The one place a refusal of any decision of this queue becomes the operator's words.
const refusalMessageOf = async (response: Response, fallback: string): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: { cause?: unknown } };
  } | null;
  return resolveVerificationRefusalMessage(payload?.error, fallback);
};

const closureSentenceOf = (cause: TickQueueClosureItem["cause"]): string =>
  VERIFICATION_REFUSAL_COPY[`institution_tick_closed_needs_documents:${cause}`] ?? "";

const siblingSentenceOf = (cause: TickQueueClosureItem["cause"]): string =>
  cause === "staff" ? SIBLING_CLOSED_BY_STAFF : SIBLING_CLOSED_AUTOMATICALLY;

const approvalMessageOf = (trustedSubmitter: boolean | undefined): string =>
  trustedSubmitter === true ? APPROVED_TRUSTED_MESSAGE : APPROVED_MESSAGE;

const paidDraftSentenceOf = (draft: TickNameCheckItem["paidDraft"]): string => {
  const fee = formatRupiah(draft.feeAmount, draft.feeCurrency ?? "IDR");
  return `Kompetisi berbayar: ${draft.title}, ${fee}.`;
};

function ReviewPanelBody({
  detail,
  closeModal,
  onReviewed,
}: {
  detail: SubmissionDetail;
  closeModal: () => void;
  onReviewed: () => void;
}) {
  const [notes, setNotes] = useState("");
  // Which decision is in flight, so the spinner lands on the button the reviewer pressed.
  const [pendingDecision, setPendingDecision] = useState<"approved" | "rejected" | null>(null);
  const { addToast } = useToast();

  const documentRows: TableRowData[] = detail.documents.map((doc) => ({
    key: doc.id,
    cells: {
      type: DOCUMENT_TYPE_LABELS[doc.documentType] ?? formatDisplayToken(doc.documentType),
      fileName: doc.originalFileName,
      format: doc.contentType,
    },
  }));

  const submitDecision = async (decision: "approved" | "rejected") => {
    setPendingDecision(decision);
    try {
      const response = await fetch(`${SUBMISSION_URL}/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewerNotes: notes.trim() || null }),
      });
      if (!response.ok) {
        addToast({
          type: "error",
          message: await refusalMessageOf(response, DECISION_FALLBACK[decision]),
        });
        return;
      }
      const answer = (await response.json()) as { trustedSubmitter?: boolean };
      const message =
        decision === "approved" ? approvalMessageOf(answer.trustedSubmitter) : TURNED_DOWN_MESSAGE;
      addToast({ type: "success", message });
      closeModal();
      onReviewed();
    } catch {
      addToast({ type: "error", message: DECISION_NETWORK_MESSAGE });
    } finally {
      setPendingDecision(null);
    }
  };

  return (
    <div className="stack-md admin-review-panel">
      <p className="muted-copy">
        <strong>{detail.institutionDisplayName}</strong> →{" "}
        {INSTITUTION_TYPE_LABELS[detail.targetInstitutionType]}
        {detail.proposedDisplayName && (
          <span className="admin-proposed-name">
            Nama: &ldquo;{detail.proposedDisplayName}&rdquo;
          </span>
        )}
      </p>

      {detail.documents.length > 0 && (
        <div className="stack-sm">
          <FormLabelText as="p">Dokumen</FormLabelText>
          <Table label="Dokumen" columns={DOCUMENT_COLUMNS} rows={documentRows} />
        </div>
      )}

      <div className="form-field">
        <FormLabel htmlFor="reviewer-notes-textarea" optional>
          Catatan reviewer
        </FormLabel>
        <FormTextarea
          id="reviewer-notes-textarea"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Catatan untuk pemilik institusi..."
        />
      </div>

      <div className="modal-actions">
        <Button variant="outline" onClick={() => closeModal()} disabled={pendingDecision !== null}>
          Batal
        </Button>
        <Button
          variant="primary"
          onClick={() => void submitDecision("rejected")}
          loading={pendingDecision === "rejected"}
          disabled={pendingDecision !== null}
        >
          Tolak
        </Button>
        <Button
          onClick={() => void submitDecision("approved")}
          loading={pendingDecision === "approved"}
          disabled={pendingDecision !== null}
        >
          Setujui
        </Button>
      </div>
    </div>
  );
}

// The pop-up footer submits this form. A blank reason where one is required shows the field error
// and sends nothing.
function ReasonForm({
  formId,
  sentence,
  isReasonRequired,
  hasLimit,
  onSubmit,
}: {
  formId: string;
  sentence: string;
  isReasonRequired: boolean;
  hasLimit: boolean;
  onSubmit: (reason: string) => Promise<ModalOutcome>;
}) {
  const runModalTask = useModalTask();
  const [reason, setReason] = useState("");
  const [hasTriedToSubmit, setHasTriedToSubmit] = useState(false);
  const trimmedReason = reason.trim();
  const showsReasonError = hasTriedToSubmit && isReasonRequired && trimmedReason.length === 0;
  // A refused submit moves focus to the field it marks, after the render that marks it.
  const formRef = useRef<HTMLFormElement>(null);
  const [errorFocusRequest, setErrorFocusRequest] = useState(0);
  useEffect(() => {
    if (errorFocusRequest === 0) return;
    focusFirstInvalidField(formRef.current);
  }, [errorFocusRequest]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHasTriedToSubmit(true);
    if (isReasonRequired && trimmedReason.length === 0) {
      setErrorFocusRequest((request) => request + 1);
      return;
    }
    void runModalTask(() => onSubmit(trimmedReason));
  };

  return (
    <form id={formId} ref={formRef} noValidate onSubmit={submit} className="stack-md">
      <p>{sentence}</p>
      <FormField>
        <FormLabel
          htmlFor={REASON_FIELD_ID}
          required={isReasonRequired}
          optional={!isReasonRequired}
        >
          Alasan
        </FormLabel>
        {hasLimit ? (
          <FormTextareaWithLimit
            id={REASON_FIELD_ID}
            value={reason}
            maxLength={REASON_MAX_LENGTH}
            rows={4}
            error={showsReasonError ? REASON_REQUIRED_MESSAGE : undefined}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : (
          <>
            <FormTextarea
              id={REASON_FIELD_ID}
              value={reason}
              rows={4}
              aria-invalid={showsReasonError ? true : undefined}
              aria-describedby={showsReasonError ? REASON_ERROR_ID : undefined}
              onChange={(event) => setReason(event.target.value)}
            />
            {showsReasonError ? (
              <FormError id={REASON_ERROR_ID}>{REASON_REQUIRED_MESSAGE}</FormError>
            ) : null}
          </>
        )}
      </FormField>
    </form>
  );
}

function RequestBadge({ overdue }: { overdue: boolean }) {
  return overdue ? (
    <span className="status-badge" data-status="overdue">
      Terlambat
    </span>
  ) : (
    <span className="status-badge" data-status="awaiting">
      Menunggu
    </span>
  );
}

function WorkspaceHeading({
  displayName,
  slug,
  trailing,
}: {
  displayName: string;
  slug: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h3>{displayName}</h3>
        <p className="muted-copy">{slug}</p>
      </div>
      {trailing}
    </div>
  );
}

function SiblingClosures({ closures }: { closures: TickQueueClosureItem[] }) {
  if (closures.length === 0) return null;
  return (
    <Feedback tone="warning">
      {closures.map((closure, index) => (
        <p key={`${closure.closedInstitutionId}-${index}`}>{siblingSentenceOf(closure.cause)}</p>
      ))}
    </Feedback>
  );
}

function LastLeftVerified({ entry }: { entry: NonNullable<TickRequestItem["lastLeftVerified"]> }) {
  const rows = [
    { label: "Ke", value: INSTITUTION_VERIFICATION_STATUS_LABELS[entry.toStatus] },
    ...(entry.reason === null ? [] : [{ label: "Alasan", value: entry.reason }]),
    ...(entry.actorUserId === null ? [] : [{ label: "Aktor", value: entry.actorUserId }]),
    { label: "Waktu", value: <LocalDate value={entry.createdAt} format="shortDateTime" /> },
  ];
  return (
    <div className="stack-xs">
      <h4>{LAST_LEFT_VERIFIED_HEADING}</h4>
      <DetailList rows={rows} />
    </div>
  );
}

function InstagramInstruction({
  pageUrl,
  instagramUrl,
}: {
  pageUrl: string;
  instagramUrl: string;
}) {
  return (
    <p>
      {`Cari tautan ${pageUrl} di bio `}
      <a href={instagramUrl} target="_blank" rel="noopener noreferrer">
        {instagramUrl}
      </a>
      {"."}
    </p>
  );
}

const requestFactRowsOf = (item: TickRequestItem) => [
  ...(item.submitterEmail === null ? [] : [{ label: "Submitter", value: item.submitterEmail }]),
  { label: "Dikirim", value: <LocalDate value={item.submittedAt} format="longDateTime" /> },
  ...(item.requestedPath === "documents" ? [{ label: "Dokumen", value: item.documentCount }] : []),
];

function TickRequestCard({
  item,
  isOpeningReview,
  onReview,
}: {
  item: TickRequestItem;
  isOpeningReview: boolean;
  onReview: () => void;
}) {
  return (
    <Card as="li" className="content-section stack-md">
      <WorkspaceHeading
        displayName={item.institutionDisplayName}
        slug={item.institutionSlug}
        trailing={<RequestBadge overdue={item.overdue} />}
      />
      {item.requestedPath === "instagram" && item.instagramUrl !== null ? (
        <InstagramInstruction pageUrl={item.pageUrl} instagramUrl={item.instagramUrl} />
      ) : null}
      <DetailList rows={requestFactRowsOf(item)} />
      <p className="muted-copy">
        {item.submitterWouldBeTrusted ? TRUSTED_ON_APPROVAL_NOTE : NOT_TRUSTED_ON_APPROVAL_NOTE}
      </p>
      {item.closure !== null ? (
        <Feedback tone="warning">
          <p>{closureSentenceOf(item.closure.cause)}</p>
        </Feedback>
      ) : null}
      {item.lastLeftVerified !== null ? <LastLeftVerified entry={item.lastLeftVerified} /> : null}
      <SiblingClosures closures={item.siblingClosures} />
      <div className="record-actions">
        <Button type="button" size="sm" loading={isOpeningReview} onClick={onReview}>
          Tinjau
        </Button>
      </div>
    </Card>
  );
}

function TickNameCheckCard({
  item,
  onRevoke,
  onRequireProof,
  onNameOk,
}: {
  item: TickNameCheckItem;
  onRevoke: () => void;
  onRequireProof: () => void;
  onNameOk: () => void;
}) {
  const factRows = [
    ...(item.tickDomain === null ? [] : [{ label: "Domain centang", value: item.tickDomain }]),
    ...(item.ownerEmailDomains.length === 0
      ? []
      : [
          {
            label: "Domain Email organisasi pemilik",
            value: item.ownerEmailDomains.join(", "),
          },
        ]),
    { label: "Menunggu sejak", value: <LocalDate value={item.since} format="longDate" /> },
  ];
  return (
    <Card as="li" className="content-section stack-md">
      <WorkspaceHeading displayName={item.institutionDisplayName} slug={item.institutionSlug} />
      <DetailList rows={factRows} />
      <p className="muted-copy">{paidDraftSentenceOf(item.paidDraft)}</p>
      <SiblingClosures closures={item.siblingClosures} />
      <div className="record-actions">
        <Button type="button" variant="outline" size="sm" onClick={onRevoke}>
          Cabut centang
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRequireProof}>
          Minta bukti nama
        </Button>
        <Button type="button" size="sm" onClick={onNameOk}>
          Nama sesuai
        </Button>
      </div>
    </Card>
  );
}

function TickProofCard({
  item,
  onRevoke,
  onNameOk,
}: {
  item: TickProofItem;
  onRevoke: () => void;
  onNameOk: () => void;
}) {
  return (
    <Card as="li" className="content-section stack-md">
      <WorkspaceHeading displayName={item.institutionDisplayName} slug={item.institutionSlug} />
      <p className="muted-copy">
        {"Batas bukti "}
        <LocalDate value={item.nameProofDueAt} format="longDate" />
      </p>
      {item.reminded ? <p className="muted-copy">Pengingat terkirim</p> : null}
      <div className="record-actions">
        <Button type="button" variant="outline" size="sm" onClick={onRevoke}>
          Cabut centang
        </Button>
        <Button type="button" size="sm" onClick={onNameOk}>
          Nama sesuai
        </Button>
      </div>
    </Card>
  );
}

function TickSection({
  title,
  isEmpty,
  children,
}: {
  title: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="stack-md">
      <h2>{title}</h2>
      {isEmpty ? (
        <EmptyState
          kind="queue-clear"
          size="compact"
          title="Antrean sudah bersih"
          description="Tidak ada yang menunggu."
        />
      ) : (
        <ul className="stack-md">{children}</ul>
      )}
    </section>
  );
}

// The staff Centang queue: tick requests, name checks and running name proofs, each decided
// through its own route.
export function TickQueue() {
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();
  const [queue, setQueue] = useState<QueueState>({ status: "loading" });
  const [openingReviewId, setOpeningReviewId] = useState<string | null>(null);

  // Reads the queue, or answers null after a toast. It sets no state, so the mount effect and the
  // reload can both await it.
  const fetchTickQueue = useCallback(async (): Promise<TickQueueItems | null> => {
    try {
      const response = await fetch(QUEUE_URL);
      if (!response.ok) {
        addToast({ type: "error", message: QUEUE_LOAD_FALLBACK });
        return null;
      }
      const payload = (await response.json()) as { tickQueue: TickQueueItems };
      return payload.tickQueue;
    } catch {
      addToast({ type: "error", message: QUEUE_LOAD_NETWORK_MESSAGE });
      return null;
    }
  }, [addToast]);

  const reload = useCallback(async () => {
    setQueue({ status: "loading" });
    setQueue(queueStateOf(await fetchTickQueue()));
  }, [fetchTickQueue]);

  useEffect(() => {
    let active = true;
    void fetchTickQueue().then((items) => {
      if (active) setQueue(queueStateOf(items));
    });
    return () => {
      active = false;
    };
  }, [fetchTickQueue]);

  const openReview = async (submissionId: string) => {
    setOpeningReviewId(submissionId);
    try {
      const response = await fetch(`${SUBMISSION_URL}/${submissionId}`);
      if (!response.ok) {
        addToast({ type: "error", message: DETAIL_LOAD_FALLBACK });
        return;
      }
      const payload = (await response.json()) as { submission: SubmissionDetail };
      openModal({
        title: "Tinjau pengajuan",
        body: (
          <ReviewPanelBody
            detail={payload.submission}
            closeModal={closeModal}
            onReviewed={() => void reload()}
          />
        ),
        wide: true,
        actions: [],
      });
    } catch {
      addToast({ type: "error", message: DETAIL_LOAD_NETWORK_MESSAGE });
    } finally {
      setOpeningReviewId(null);
    }
  };

  // The pop-up shows the waiting and a refusal, so this reports an outcome and toasts only the
  // success.
  const sendDecision = useCallback(
    async (decision: DecisionRequest): Promise<ModalOutcome> => {
      try {
        const response = await fetch(decision.url, {
          method: decision.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(decision.body),
        });
        if (!response.ok) {
          return { ok: false, message: await refusalMessageOf(response, decision.fallback) };
        }
        addToast({ type: "success", message: decision.successMessage });
        void reload();
        return { ok: true };
      } catch {
        return { ok: false, message: NETWORK_ERROR_MESSAGE };
      }
    },
    [addToast, reload],
  );

  const nameCheckUrlOf = (institutionId: string): string =>
    `${NAME_CHECK_URL}/${encodeURIComponent(institutionId)}/name-check`;

  const openNameOk = (institutionId: string, isProofRunning: boolean) => {
    const sendNameOk = (reason: string) => {
      const body = reason === "" ? { decision: "name_ok" } : { decision: "name_ok", reason };
      return sendDecision({
        url: nameCheckUrlOf(institutionId),
        method: "POST",
        body,
        successMessage: NAME_OK_MESSAGE,
        fallback: NAME_OK_FALLBACK,
      });
    };
    openModal({
      title: "Nama sesuai",
      wide: true,
      formId: NAME_OK_FORM_ID,
      body: (
        <ReasonForm
          formId={NAME_OK_FORM_ID}
          sentence={NAME_OK_SENTENCE}
          isReasonRequired={isProofRunning}
          hasLimit
          onSubmit={sendNameOk}
        />
      ),
      actions: [{ label: "Batal" }, { label: "Nama sesuai", variant: "primary" }],
    });
  };

  const openRequireProof = (institutionId: string) => {
    const sendRequireProof = (reason: string) =>
      sendDecision({
        url: nameCheckUrlOf(institutionId),
        method: "POST",
        body: { decision: "require_proof", reason },
        successMessage: REQUIRE_PROOF_MESSAGE,
        fallback: REQUIRE_PROOF_FALLBACK,
      });
    openModal({
      title: "Minta bukti nama",
      wide: true,
      formId: REQUIRE_PROOF_FORM_ID,
      body: (
        <ReasonForm
          formId={REQUIRE_PROOF_FORM_ID}
          sentence={REQUIRE_PROOF_SENTENCE}
          isReasonRequired
          hasLimit
          onSubmit={sendRequireProof}
        />
      ),
      actions: [{ label: "Batal" }, { label: "Minta bukti nama", variant: "primary" }],
    });
  };

  const openRevoke = (institutionId: string) => {
    const sendRevoke = (reason: string) =>
      sendDecision({
        url: `${VERIFY_URL}/${encodeURIComponent(institutionId)}/verify`,
        method: "PATCH",
        body: { targetStatus: "rejected", reason },
        successMessage: REVOKE_MESSAGE,
        fallback: REVOKE_FALLBACK,
      });
    openModal({
      title: "Cabut centang",
      wide: true,
      formId: REVOKE_FORM_ID,
      body: (
        <ReasonForm
          formId={REVOKE_FORM_ID}
          sentence={REVOKE_SENTENCE}
          isReasonRequired
          hasLimit={false}
          onSubmit={sendRevoke}
        />
      ),
      actions: [{ label: "Batal" }, { label: "Cabut centang", variant: "primary" }],
    });
  };

  if (queue.status === "loading") {
    return (
      <div
        className="content-section stack-sm"
        role="status"
        aria-busy="true"
        aria-label="Memuat antrean verifikasi"
      >
        <Skeleton variant="media" />
        <Skeleton variant="media" />
        <Skeleton variant="media" />
      </div>
    );
  }

  if (queue.status === "failed") {
    return (
      <EmptyState
        kind="not-found"
        title="Antrean belum dapat dimuat"
        description="Muat ulang untuk mencoba lagi."
        action={{ label: "Muat ulang", onSelect: () => void reload() }}
      />
    );
  }

  const { requests, nameChecks, runningProofs } = queue.items;

  return (
    <div className="stack-md">
      <TickSection title="Permintaan centang" isEmpty={requests.length === 0}>
        {requests.map((item) => (
          <TickRequestCard
            key={item.submissionId}
            item={item}
            isOpeningReview={openingReviewId === item.submissionId}
            onReview={() => void openReview(item.submissionId)}
          />
        ))}
      </TickSection>
      <TickSection title="Pemeriksaan nama" isEmpty={nameChecks.length === 0}>
        {nameChecks.map((item) => (
          <TickNameCheckCard
            key={item.institutionId}
            item={item}
            onRevoke={() => openRevoke(item.institutionId)}
            onRequireProof={() => openRequireProof(item.institutionId)}
            onNameOk={() => openNameOk(item.institutionId, false)}
          />
        ))}
      </TickSection>
      <TickSection title="Bukti nama berjalan" isEmpty={runningProofs.length === 0}>
        {runningProofs.map((item) => (
          <TickProofCard
            key={item.institutionId}
            item={item}
            onRevoke={() => openRevoke(item.institutionId)}
            onNameOk={() => openNameOk(item.institutionId, true)}
          />
        ))}
      </TickSection>
    </div>
  );
}
