"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModal, useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";
import {
  Button,
  CountPill,
  EmptyState,
  Feedback,
  FormActionBar,
  FormHelp,
  FormInput,
  FormLabel,
  FormLabelText,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import {
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENTS_BY_TYPE,
} from "@/server/institution-verification/verification-requirements";
import type {
  TickPageClosureCause,
  TickPageState,
} from "@/server/institution-verification/tick-service";
import type { TickPath } from "@/server/institution-verification/tick-transition";
import type { InstitutionType } from "@/server/db/schema";
import { INSTITUTION_TYPE_LABELS } from "@/lib/institutions/type-labels";
import { VERIFICATION_REFUSAL_COPY } from "@/lib/institutions/verification-refusal-copy";
import { formatDisplayToken } from "@/lib/text/capitalize";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";

type SubmissionItem = {
  id: string;
  targetInstitutionType: InstitutionType;
  proposedDisplayName: string | null;
  status: "pending_review" | "approved" | "rejected";
  submittedAt: string;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  documentCount: number;
};

const STATUS_LABELS: Record<SubmissionItem["status"], string> = {
  pending_review: "Menunggu Ditinjau",
  approved: "Disetujui",
  rejected: "Ditolak",
};

const HISTORY_COLUMNS: readonly TableColumn[] = [
  { key: "target", header: "Tipe tujuan", kind: "name" },
  { key: "status", header: "Status", kind: "pill" },
  { key: "documents", header: "Dokumen", kind: "number" },
  { key: "submittedAt", header: "Dikirim", kind: "date" },
  { key: "notes", header: "Catatan", kind: "wrap" },
];

const submissionStatusTone = (status: SubmissionItem["status"]): string => {
  if (status === "approved") return "open";
  if (status === "rejected") return "closing";
  return "awaiting";
};

const buildHistoryRow = (submission: SubmissionItem): TableRowData => ({
  key: submission.id,
  cells: {
    target: INSTITUTION_TYPE_LABELS[submission.targetInstitutionType],
    status: (
      <span className="status-badge" data-status={submissionStatusTone(submission.status)}>
        {STATUS_LABELS[submission.status]}
      </span>
    ),
    documents: submission.documentCount,
    submittedAt: <LocalDate value={submission.submittedAt} format="shortDate" />,
    notes: submission.reviewerNotes,
  },
});

type DocField = {
  documentType: string;
  fileName: string;
  file: File | null;
};

type DocumentUploadTarget = { documentType: string; uploadUrl: string; r2Key: string };

type PendingPath = "domain" | "instagram" | "documents";

type InstitutionVerificationShellProps = {
  institutionSlug: string;
  expectedUserId: string;
  institutionId: string;
  // The institution's type, fixed at creation. Verification proves it and never chooses it. It
  // decides whether the Dokumen card offers the form and which closure sentence the page reads.
  institutionType: InstitutionType;
  displayName: string;
  pageUrl: string;
  // Read server-side from the institution's own verification_status. A verified workspace gets no
  // Email organisasi card, and gets the Instagram and Dokumen cards only while its tick path is
  // domain. The server refuses every other request anyway; this keeps the page from offering an
  // action it would then reject.
  isVerified: boolean;
  // Non-null only while the institution itself sits at 'rejected' — either a denial or a revoked
  // verification. It is the instruction the owner works from, so it renders as page content that
  // survives a reload, never as a toast.
  rejectionReason: string | null;
  tickPath: TickPath | null;
  nameChecked: boolean;
  nameProofDueAt: string | null;
  tickState: TickPageState;
};

const SUBMIT_FALLBACK = "Pengajuan gagal dikirim. Coba lagi.";

const verificationSentence = (code: string): string =>
  errorMessageFor(code, VERIFICATION_REFUSAL_COPY, SUBMIT_FALLBACK);

const LIVE_PAID_SENTENCE = verificationSentence("institution_tick_live_paid_competition");
const NAME_PROOF_NEEDS_DOCUMENTS_SENTENCE = verificationSentence(
  "institution_name_proof_needs_documents",
);
const DOMAIN_MISMATCH_SENTENCE =
  "Domain email organisasi Anda tidak sama dengan domain situs web ruang kerja ini.";
const NOT_APPLICABLE_SENTENCE =
  "Ruang kerja pribadi mendapat centang lewat email organisasi atau Instagram.";

const SUBMIT_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Hanya akun penyelenggara yang dapat mengajukan verifikasi institusi.",
  rate_limited: "Terlalu banyak permintaan unggah. Coba lagi dalam beberapa menit.",
  invalid_payload: "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  verification_storage_unavailable: "Unggahan berkas sedang tidak tersedia. Coba lagi nanti.",
  institution_not_found: "Institusi tidak ditemukan, atau Anda bukan pemiliknya.",
  institution_verification_not_applicable: NOT_APPLICABLE_SENTENCE,
  institution_already_verified: "Institusi ini sudah terverifikasi.",
  missing_required_documents: "Lengkapi semua dokumen yang dibutuhkan lalu kirim lagi.",
  verification_submission_already_pending:
    "Pengajuan verifikasi untuk institusi ini masih menunggu tinjauan.",
  institution_tick_no_organization_email: "Konfirmasi email organisasi Anda dulu.",
  institution_tick_no_website: "Isi situs web resmi ruang kerja dulu.",
  institution_tick_domain_mismatch: DOMAIN_MISMATCH_SENTENCE,
  institution_tick_owner_trust_removed:
    "Status tepercaya akun Anda dicabut staf, jadi centang tidak dapat didapat lewat email organisasi.",
  institution_tick_live_paid_competition: LIVE_PAID_SENTENCE,
  institution_name_proof_needs_documents: NAME_PROOF_NEEDS_DOCUMENTS_SENTENCE,
  institution_tick_instagram_invalid:
    "Tautan belum benar. Contoh: https://www.instagram.com/namaorganisasi",
};

// A refusal after which the page shows something different from what the owner pressed against.
const REFUSALS_THAT_RELOAD_THE_PAGE: readonly string[] = [
  "institution_already_verified",
  "verification_submission_already_pending",
  "institution_tick_path_a_closed",
  "institution_tick_closed_needs_documents",
  "institution_tick_live_paid_competition",
  "institution_name_proof_needs_documents",
  "institution_tick_no_organization_email",
  "institution_tick_no_website",
  "institution_tick_domain_mismatch",
];

const CLOSURE_REFUSALS: readonly string[] = [
  "institution_tick_path_a_closed",
  "institution_tick_closed_needs_documents",
];

const THIS_WORKSPACE_SUBJECT = "Centang ruang kerja ini";
const OTHER_WORKSPACE_SUBJECT = "Centang ruang kerja lain milik Anda";
const CLOSURE_REMEDY = ", jadi centang hanya bisa didapat lagi lewat dokumen.";
const PERSONAL_CLOSURE_REMEDY =
  ". Hubungi staf Lombakita lewat halaman kontak untuk memulihkannya.";

// Reads the closure sentences of VERIFICATION_REFUSAL_COPY for the owner. A closure on another
// workspace of the owner names that workspace, and a personal workspace has no documents path, so
// its only way back is a staff restore.
const closureLineOf = (
  cause: TickPageClosureCause,
  options: { ofOtherWorkspace: boolean; isPersonal: boolean },
): string => {
  const sentence = verificationSentence(`institution_tick_path_a_closed:${cause}`);
  const subject = options.ofOtherWorkspace
    ? sentence.replace(THIS_WORKSPACE_SUBJECT, OTHER_WORKSPACE_SUBJECT)
    : sentence;
  return options.isPersonal ? subject.replace(CLOSURE_REMEDY, PERSONAL_CLOSURE_REMEDY) : subject;
};

const PAGE_LEAD =
  "Centang menunjukkan bahwa ruang kerja ini benar milik organisasinya. Kompetisi gratis tetap bisa tayang tanpa centang. Kompetisi berbayar membutuhkan centang.";
const EMAIL_ORGANISATION_TEXT =
  "Cocok bila domain email organisasi Anda sama dengan domain situs web ruang kerja ini.";
const NO_ORGANIZATION_EMAIL_LINE = "Konfirmasi email organisasi Anda dulu di Dasbor penyelenggara.";
const NO_WEBSITE_LINE = "Isi situs web resmi di pengaturan profil ruang kerja.";
const PENDING_REQUEST_LINE =
  "Permintaan Anda sedang diperiksa staf. Perkiraan 1x24 jam pada hari kerja.";
const NAME_CHECK_PENDING_LINE =
  "Nama ruang kerja diperiksa staf sebelum kompetisi berbayar pertama tayang. Perkiraan 1x24 jam pada hari kerja.";
const DOMAIN_TICKED_TOAST = "Domain cocok. Ruang kerja ini kini mendapat centang.";
const INSTAGRAM_SENT_TOAST =
  "Tautan terkirim. Staf akan memeriksanya dalam 1x24 jam pada hari kerja.";

const TICKED_LINES: Record<TickPath, string> = {
  domain: "Ruang kerja ini terverifikasi lewat email organisasi.",
  instagram: "Ruang kerja ini terverifikasi lewat Instagram.",
  documents: "Ruang kerja ini terverifikasi lewat dokumen.",
  staff: "Ruang kerja ini terverifikasi lewat keputusan staf.",
};

const UNLABELLED_DOCUMENT_LABEL = "Dokumen lainnya";

// The sentence that stops the Email organisasi card from offering its button, in the order the
// domain route refuses. Null means the button may be offered.
const emailCardBlockOf = (tickState: TickPageState, isPersonal: boolean): string | null => {
  if (tickState.workspaceClosure) {
    return closureLineOf(tickState.workspaceClosure, { ofOtherWorkspace: false, isPersonal });
  }
  if (tickState.otherWorkspaceClosure) {
    return closureLineOf(tickState.otherWorkspaceClosure, { ofOtherWorkspace: true, isPersonal });
  }
  if (tickState.hasPublishedPaidCompetition) return LIVE_PAID_SENTENCE;
  if (tickState.organizationEmailDomain === null) return NO_ORGANIZATION_EMAIL_LINE;
  if (tickState.websiteHost === null) return NO_WEBSITE_LINE;
  return null;
};

const instagramCardBlockOf = (
  tickState: TickPageState,
  options: { isVerified: boolean; nameProofRuns: boolean; isPersonal: boolean },
): string | null => {
  if (tickState.workspaceClosure) {
    return closureLineOf(tickState.workspaceClosure, {
      ofOtherWorkspace: false,
      isPersonal: options.isPersonal,
    });
  }
  if (!options.isVerified && tickState.hasPublishedPaidCompetition) return LIVE_PAID_SENTENCE;
  if (options.isVerified && options.nameProofRuns) return NAME_PROOF_NEEDS_DOCUMENTS_SENTENCE;
  return null;
};

type RefusalError = { code?: string; details?: { cause?: unknown; closedInstitutionId?: unknown } };

const readRefusalError = async (response: Response): Promise<RefusalError> => {
  try {
    const data = (await response.json()) as { error?: RefusalError };
    return data.error ?? {};
  } catch {
    // A body that is not JSON carries no code, so the modal shows the fallback.
    return {};
  }
};

const NameStateNotice = ({
  nameChecked,
  nameProofDueAt,
  displayName,
}: {
  nameChecked: boolean;
  nameProofDueAt: string | null;
  displayName: string;
}) => {
  if (nameProofDueAt !== null) {
    return (
      <Feedback tone="warning">
        <p>
          Staf meminta bukti bahwa ruang kerja ini berhak memakai nama {displayName}. Kirim dokumen
          sebagai bukti sebelum <LocalDate value={nameProofDueAt} format="longDate" />. Tanpa bukti,
          centang dicabut otomatis.
        </p>
      </Feedback>
    );
  }
  if (nameChecked) return null;
  return <p className="muted-copy">{NAME_CHECK_PENDING_LINE}</p>;
};

type PathCardAction = { loading: boolean; disabled: boolean; onPress: () => void };

const EmailOrganisationCard = ({
  tickState,
  isPersonal,
  action,
}: {
  tickState: TickPageState;
  isPersonal: boolean;
  action: PathCardAction;
}) => {
  const block = emailCardBlockOf(tickState, isPersonal);
  return (
    <section className="content-section verification-submit-card">
      <div className="section-heading">
        <div>
          <h2>Email organisasi</h2>
        </div>
      </div>
      <p className="muted-copy">{EMAIL_ORGANISATION_TEXT}</p>
      {block !== null ? (
        <Feedback tone="warning">
          <p>{block}</p>
        </Feedback>
      ) : (
        <>
          <p className="muted-copy">
            {`Email organisasi Anda: ${tickState.organizationEmailDomain}. Situs web: ${tickState.websiteHost}.`}
          </p>
          {tickState.domainsMatch ? (
            <div className="cluster">
              <Button
                type="button"
                onClick={action.onPress}
                loading={action.loading}
                disabled={action.disabled}
                leadingIcon={<Icon name="check" />}
              >
                Cocokkan domain
              </Button>
            </div>
          ) : (
            <Feedback tone="warning">
              <p>{DOMAIN_MISMATCH_SENTENCE}</p>
            </Feedback>
          )}
        </>
      )}
    </section>
  );
};

const InstagramCard = ({
  blockingLine,
  pageUrl,
  instagramUrl,
  onInstagramUrlChange,
  action,
}: {
  blockingLine: string | null;
  pageUrl: string;
  instagramUrl: string;
  onInstagramUrlChange: (value: string) => void;
  action: PathCardAction;
}) => (
  <section className="content-section verification-submit-card">
    <div className="section-heading">
      <div>
        <h2>Instagram resmi</h2>
      </div>
    </div>
    {blockingLine !== null ? (
      <Feedback tone="warning">
        <p>{blockingLine}</p>
      </Feedback>
    ) : (
      <>
        <div className="form-field">
          <FormLabel htmlFor="tick-instagram-url" required>
            Tautan profil Instagram
          </FormLabel>
          <FormInput
            id="tick-instagram-url"
            type="url"
            value={instagramUrl}
            onChange={(event) => onInstagramUrlChange(event.target.value)}
            required
          />
          <FormHelp>
            {`Pasang tautan ${pageUrl} di bio Instagram resmi Anda, atau di halaman tautan seperti Linktree atau lynk.id yang ada di bio. Tautan ke beranda Lombakita tidak dihitung.`}
          </FormHelp>
        </div>
        <div className="cluster">
          <Button
            type="button"
            onClick={action.onPress}
            loading={action.loading}
            disabled={action.disabled}
            leadingIcon={<Icon name="link" />}
          >
            Kirim untuk diperiksa
          </Button>
        </div>
      </>
    )}
  </section>
);

const DocumentsCard = ({
  institutionType,
  isPersonal,
  docFields,
  onFileChange,
  action,
}: {
  institutionType: InstitutionType;
  isPersonal: boolean;
  docFields: DocField[];
  onFileChange: (index: number, file: File | null) => void;
  action: PathCardAction;
}) => (
  <section className="content-section verification-submit-card">
    <div className="section-heading">
      <div>
        <h2>Dokumen</h2>
      </div>
    </div>
    {isPersonal ? (
      <Feedback tone="warning">
        <p>{NOT_APPLICABLE_SENTENCE}</p>
      </Feedback>
    ) : (
      <>
        {/* The type is fixed at creation and cannot change — verification proves it, it does not
            choose it. Rendered as a read-only fact, not a control. */}
        <dl className="profile-detail-list">
          <div>
            <dt>Tipe institusi</dt>
            <dd>{INSTITUTION_TYPE_LABELS[institutionType]}</dd>
          </div>
        </dl>

        <div className="verification-documents">
          <FormLabelText as="p">Dokumen yang dibutuhkan</FormLabelText>
          {docFields.map((field, i) => (
            <div key={field.documentType} className="form-field verification-document-field">
              <FormLabel htmlFor={`doc-${field.documentType}`} required>
                {DOCUMENT_TYPE_LABELS[field.documentType] ?? formatDisplayToken(field.documentType)}
              </FormLabel>
              <input
                id={`doc-${field.documentType}`}
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => onFileChange(i, e.target.files?.[0] ?? null)}
                className="form-file"
              />
            </div>
          ))}
        </div>
        <div className="cluster">
          <Button
            type="button"
            onClick={action.onPress}
            loading={action.loading}
            disabled={action.disabled}
            leadingIcon={<Icon name="upload" />}
          >
            Kirim dokumen
          </Button>
        </div>
      </>
    )}
  </section>
);

export const InstitutionVerificationShell = ({
  institutionSlug,
  expectedUserId,
  institutionId,
  institutionType,
  displayName,
  pageUrl,
  isVerified,
  rejectionReason,
  tickPath,
  nameChecked,
  nameProofDueAt,
  tickState,
}: InstitutionVerificationShellProps) => {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();

  const [submissions, setSubmissions] = useState<SubmissionItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [docFields, setDocFields] = useState<DocField[]>([]);
  const [instagramUrl, setInstagramUrl] = useState("");
  const [pendingPath, setPendingPath] = useState<PendingPath | null>(null);

  const isPersonal = institutionType === "personal";

  // The server accepts an Instagram or document request only while there is something left to
  // decide: a workspace whose tick came from Instagram, documents or staff has its answer, and one
  // with a request in the queue has a reviewer holding it. These derivations decide what the page
  // offers; the refusal itself is server-side.
  const offersInstagramAndDocuments = !isVerified || tickPath === "domain";
  const pendingSubmission = submissions.find((s) => s.status === "pending_review") ?? null;
  const approvedSubmission = submissions.find((s) => s.status === "approved") ?? null;
  const canSubmit = offersInstagramAndDocuments && !pendingSubmission;

  useEffect(() => {
    const requiredDocs = REQUIRED_DOCUMENTS_BY_TYPE[institutionType] ?? [];
    setDocFields(
      requiredDocs.map((dt) => ({
        documentType: dt,
        fileName: "",
        file: null,
      })),
    );
  }, [institutionType]);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/v1/institutions/${institutionSlug}/verification/submissions`);
      if (res.ok) {
        const data = (await res.json()) as { submissions: SubmissionItem[] };
        setSubmissions(data.submissions);
      }
    } catch {
      // Silently degrade — history not critical to rendering the form
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    void fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institutionSlug]);

  const showSubmissionFailure = (message: string) => {
    openModal({
      title: "Pengajuan gagal",
      body: message,
      alert: true,
      actions: [{ label: "Mengerti", variant: "primary" }],
    });
  };

  const refusalMessageOf = (error: RefusalError): string => {
    const cause = error.details?.cause;
    const isClosureWithCause =
      error.code !== undefined &&
      CLOSURE_REFUSALS.includes(error.code) &&
      (cause === "staff" || cause === "automatic");
    if (isClosureWithCause) {
      return closureLineOf(cause, {
        ofOtherWorkspace: error.details?.closedInstitutionId !== institutionId,
        isPersonal,
      });
    }
    return errorMessageFor(error.code ?? null, SUBMIT_ERROR_COPY, SUBMIT_FALLBACK);
  };

  const showRefusal = async (response: Response) => {
    const error = await readRefusalError(response);
    showSubmissionFailure(refusalMessageOf(error));
    // This page was rendered before the workspace reached a state that closes the path the owner
    // pressed: a verdict landed, another owner filed first, or staff closed the workspace. Pull the
    // current state back in so it stops offering an action the server will keep refusing.
    if (error.code !== undefined && REFUSALS_THAT_RELOAD_THE_PAGE.includes(error.code)) {
      router.refresh();
      await fetchHistory();
    }
  };

  const runPathRequest = async (
    path: PendingPath,
    sendRequest: () => Promise<Response>,
    handleAccepted: (response: Response) => Promise<void>,
  ) => {
    setPendingPath(path);
    try {
      const response = await sendRequest();
      if (!response.ok) {
        await showRefusal(response);
        return;
      }
      await handleAccepted(response);
    } catch {
      showSubmissionFailure(NETWORK_ERROR_MESSAGE);
    } finally {
      setPendingPath(null);
    }
  };

  const submitUrl = `/api/v1/institutions/${institutionSlug}/verification/submit`;

  const pressMatchDomain = () =>
    runPathRequest(
      "domain",
      () =>
        sessionFetch(expectedUserId, `/api/v1/institutions/${institutionSlug}/tick/domain`, {
          method: "POST",
        }),
      async () => {
        addToast({ type: "success", message: DOMAIN_TICKED_TOAST });
        router.refresh();
      },
    );

  const sendInstagramLink = () =>
    runPathRequest(
      "instagram",
      () =>
        sessionFetch(expectedUserId, submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "instagram", instagramUrl }),
        }),
      async () => {
        addToast({ type: "success", message: INSTAGRAM_SENT_TOAST });
        setInstagramUrl("");
        await fetchHistory();
      },
    );

  const uploadDocumentFile = async (uploadTarget: DocumentUploadTarget): Promise<boolean> => {
    const field = docFields.find((f) => f.documentType === uploadTarget.documentType);
    if (!field?.file) return true;
    try {
      const uploadRes = await fetch(uploadTarget.uploadUrl, {
        method: "PUT",
        body: field.file,
        headers: { "Content-Type": field.file.type || "application/octet-stream" },
      });
      return uploadRes.ok;
    } catch {
      return false;
    }
  };

  const reportDocumentsAccepted = async (response: Response) => {
    const data = (await response.json()) as { documents?: DocumentUploadTarget[] };

    // Upload each document file to its presigned R2 URL.
    const uploadErrors: string[] = [];
    for (const uploadTarget of data.documents ?? []) {
      const uploaded = await uploadDocumentFile(uploadTarget);
      if (!uploaded) {
        uploadErrors.push(
          DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ?? UNLABELLED_DOCUMENT_LABEL,
        );
      }
    }

    if (uploadErrors.length > 0) {
      addToast({
        type: "error",
        message: `Pengajuan dibuat, tetapi dokumen berikut gagal diunggah: ${uploadErrors.join(", ")}. Hubungi dukungan Lombakita.`,
      });
    } else {
      addToast({
        type: "success",
        message: "Dokumen berhasil dikirim. Kami akan meninjau dalam 1 sampai 3 hari kerja.",
      });
    }

    await fetchHistory();
  };

  const sendDocuments = async () => {
    for (const field of docFields) {
      if (!field.file) {
        openModal({
          title: "Dokumen belum lengkap",
          body: `Unggah dokumen ${DOCUMENT_TYPE_LABELS[field.documentType] ?? formatDisplayToken(field.documentType)} sebelum melanjutkan.`,
          actions: [{ label: "Mengerti", variant: "primary" }],
        });
        return;
      }
    }

    const documents = docFields.map((f) => ({
      documentType: f.documentType,
      originalFileName: f.file!.name,
      fileSizeBytes: f.file!.size,
      contentType: f.file!.type || "application/octet-stream",
    }));

    await runPathRequest(
      "documents",
      () =>
        sessionFetch(expectedUserId, submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documents }),
        }),
      reportDocumentsAccepted,
    );
  };

  const changeDocumentFile = (index: number, file: File | null) => {
    setDocFields((prev) =>
      prev.map((f, idx) => (idx === index ? { ...f, file, fileName: file?.name ?? "" } : f)),
    );
  };

  const cardAction = (path: PendingPath, onPress: () => void): PathCardAction => ({
    loading: pendingPath === path,
    disabled: pendingPath !== null && pendingPath !== path,
    onPress,
  });

  return (
    <main className="page-shell app-page institution-verification-page">
      <PageHeader title="Centang terverifikasi" description={PAGE_LEAD} />

      {isVerified && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <h2>Institusi terverifikasi</h2>
            </div>
          </div>
          {approvedSubmission?.reviewerNotes ? (
            <p className="muted-copy">
              <strong>Catatan peninjau:</strong> {approvedSubmission.reviewerNotes}
            </p>
          ) : null}
          {tickPath !== null ? <p className="muted-copy">{TICKED_LINES[tickPath]}</p> : null}
          {tickPath === "domain" ? (
            <NameStateNotice
              nameChecked={nameChecked}
              nameProofDueAt={nameProofDueAt}
              displayName={displayName}
            />
          ) : null}
        </section>
      )}

      {!isVerified && rejectionReason && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <h2>Verifikasi tidak berlaku</h2>
            </div>
            <span className="status-badge" data-status="closing">
              Ditolak
            </span>
          </div>
          <Feedback tone="error">
            <p>
              <strong>Alasan dari tim platform:</strong> {rejectionReason}
            </p>
          </Feedback>
          <p className="muted-copy">
            Perbaiki hal di atas, lalu kirim dokumen baru untuk ditinjau ulang.
          </p>
        </section>
      )}

      {!loadingHistory && pendingSubmission && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <h2>Menunggu peninjauan</h2>
            </div>
          </div>
          <p className="muted-copy">{PENDING_REQUEST_LINE}</p>
          <p className="muted-copy">
            Selama peninjauan berlangsung, Anda belum dapat mengirim pengajuan baru, karena peninjau
            menilai berkas yang sama dengan yang Anda kirim.
          </p>
        </section>
      )}

      {!isVerified && (
        <EmailOrganisationCard
          tickState={tickState}
          isPersonal={isPersonal}
          action={cardAction("domain", () => void pressMatchDomain())}
        />
      )}

      {offersInstagramAndDocuments && loadingHistory && (
        <section className="content-section" aria-busy="true" aria-label="Memuat status verifikasi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
        </section>
      )}

      {!loadingHistory && canSubmit && (
        <>
          <InstagramCard
            blockingLine={instagramCardBlockOf(tickState, {
              isVerified,
              nameProofRuns: nameProofDueAt !== null,
              isPersonal,
            })}
            pageUrl={pageUrl}
            instagramUrl={instagramUrl}
            onInstagramUrlChange={setInstagramUrl}
            action={cardAction("instagram", () => void sendInstagramLink())}
          />
          <DocumentsCard
            institutionType={institutionType}
            isPersonal={isPersonal}
            docFields={docFields}
            onFileChange={changeDocumentFile}
            action={cardAction("documents", () => void sendDocuments())}
          />
        </>
      )}

      {/* Submission history */}
      <section className="content-section verification-history-card">
        <div className="section-heading">
          <div>
            <h2>Riwayat verifikasi</h2>
          </div>
          <CountPill count={submissions.length} />
        </div>
        {loadingHistory && (
          <div className="stack-sm" aria-label="Memuat riwayat verifikasi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        )}
        {!loadingHistory && submissions.length === 0 && (
          <EmptyState
            kind="nothing-yet"
            size="compact"
            title="Belum ada pengajuan"
            description={
              // A tick that staff gave directly has no submission behind it, so "history will
              // appear here" would be a promise nothing will keep.
              tickPath === "staff"
                ? "Institusi ini diverifikasi langsung oleh tim platform, tanpa pengajuan dokumen."
                : "Riwayat peninjauan dokumen institusi akan muncul di sini."
            }
          />
        )}
        {!loadingHistory && submissions.length > 0 && (
          <Table
            label="Riwayat verifikasi"
            columns={HISTORY_COLUMNS}
            rows={submissions.map(buildHistoryRow)}
          />
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
      </FormActionBar>
    </main>
  );
};
