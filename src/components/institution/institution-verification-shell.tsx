"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModal, useToast } from "@/components/ui/primitives";
import {
  Button,
  EmptyState,
  Feedback,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
} from "@/components/ui";
import {
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENTS_BY_TYPE,
} from "@/server/institution-verification/verification-requirements";
import type { InstitutionType } from "@/server/db/schema";
// Type-only: importing the enum VALUE would pull the Drizzle schema into the client bundle. The
// exhaustive Record below is the compile-time guarantee instead — a new full subtype fails to build
// until it is given a label here.
import type { FullInstitutionType } from "@/server/institution-workspace/institution-type";
import { formatDisplayToken } from "@/lib/text/capitalize";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

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

// Covers `personal` too: the submission history can still contain rows filed before a personal
// institution's document verification was retired.
const TYPE_LABELS: Record<InstitutionType, string> = {
  personal: "Personal",
  company: "Perusahaan",
  foundation: "Yayasan",
  university: "Universitas",
  campus_organization: "Organisasi kampus",
};

type DocField = {
  documentType: string;
  fileName: string;
  file: File | null;
};

type InstitutionVerificationShellProps = {
  institutionSlug: string;
  expectedUserId: string;
  // The institution's type, fixed at creation. Verification proves it; it never chooses or changes
  // it. Personal institutions never reach this shell (they get the upgrade page).
  institutionType: FullInstitutionType;
  // Read server-side from the institution's own verification_status, so the form is never rendered
  // for an institution that already has its verdict. The server refuses such a submission anyway;
  // this is what keeps the page from offering an action it would then reject.
  isVerified: boolean;
  verifiedAt: string | null;
  // Non-null only while the institution itself sits at 'rejected' — either a denial or a revoked
  // verification. It is the instruction the owner works from, so it renders as page content that
  // survives a reload, never as a toast.
  rejectionReason: string | null;
};

const formatLongDate = (isoDate: string): string =>
  new Date(isoDate).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

export const InstitutionVerificationShell = ({
  institutionSlug,
  expectedUserId,
  institutionType,
  isVerified,
  verifiedAt,
  rejectionReason,
}: InstitutionVerificationShellProps) => {
  const router = useRouter();
  const { openModal } = useModal();
  const { addToast } = useToast();

  const [submissions, setSubmissions] = useState<SubmissionItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [docFields, setDocFields] = useState<DocField[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // The server accepts a submission only while there is something left to decide: an institution
  // already verified has its answer, and one with a submission in the queue has a reviewer holding
  // its documents. These derivations decide what the page offers; the refusal itself is server-side.
  const pendingSubmission = submissions.find((s) => s.status === "pending_review") ?? null;
  const approvedSubmission = submissions.find((s) => s.status === "approved") ?? null;
  const canSubmit = !isVerified && !pendingSubmission;

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

  const handleSubmit = async () => {
    for (const field of docFields) {
      if (!field.file) {
        openModal({
          title: "Dokumen belum lengkap",
          body: `Unggah dokumen ${DOCUMENT_TYPE_LABELS[field.documentType] ?? formatDisplayToken(field.documentType)} sebelum melanjutkan.`,
          actions: [{ label: "OK", onClick: () => {} }],
        });
        return;
      }
    }

    setSubmitting(true);
    try {
      const documents = docFields.map((f) => ({
        documentType: f.documentType,
        originalFileName: f.file!.name,
        fileSizeBytes: f.file!.size,
        contentType: f.file!.type || "application/octet-stream",
      }));

      const res = await sessionFetch(
        expectedUserId,
        `/api/v1/institutions/${institutionSlug}/verification/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documents }),
        },
      );

      const data = (await res.json()) as {
        submissionId?: string;
        documents?: Array<{ documentType: string; uploadUrl: string; r2Key: string }>;
        error?: { code: string; message: string; details?: Record<string, unknown> };
      };

      if (!res.ok) {
        const errorCode = await readErrorCode(res.clone());
        const errMsg =
          errorCode === SESSION_MISMATCH_CODE
            ? SESSION_MISMATCH_MESSAGE
            : (data.error?.message ?? `Error ${res.status}`);
        openModal({
          title: "Pengajuan gagal",
          body: errMsg,
          actions: [{ label: "OK", onClick: () => {} }],
        });
        // This page was rendered before the institution reached a state that closes submissions —
        // a verdict landed, or another owner filed first. Pull the current state back in so it
        // stops offering an action the server will keep refusing.
        if (
          errorCode === "institution_already_verified" ||
          errorCode === "verification_submission_already_pending"
        ) {
          router.refresh();
          await fetchHistory();
        }
        return;
      }

      // Upload each document file to its presigned R2 URL.
      const uploadErrors: string[] = [];
      for (const uploadTarget of data.documents ?? []) {
        const field = docFields.find((f) => f.documentType === uploadTarget.documentType);
        if (!field?.file) continue;
        try {
          const uploadRes = await fetch(uploadTarget.uploadUrl, {
            method: "PUT",
            body: field.file,
            headers: { "Content-Type": field.file.type || "application/octet-stream" },
          });
          if (!uploadRes.ok) {
            uploadErrors.push(
              DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ??
                formatDisplayToken(uploadTarget.documentType),
            );
          }
        } catch {
          uploadErrors.push(
            DOCUMENT_TYPE_LABELS[uploadTarget.documentType] ??
              formatDisplayToken(uploadTarget.documentType),
          );
        }
      }

      if (uploadErrors.length > 0) {
        addToast({
          type: "error",
          message: `Pengajuan dibuat, tetapi upload gagal untuk: ${uploadErrors.join(", ")}. Hubungi dukungan.`,
        });
      } else {
        addToast({
          type: "success",
          message: "Dokumen berhasil dikirim. Kami akan meninjau dalam 1–3 hari kerja.",
        });
      }

      await fetchHistory();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page-shell app-page institution-verification-page">
      <PageHeader
        title="Verifikasi institusi"
        description={
          isVerified
            ? "Hasil peninjauan dokumen institusi Anda."
            : "Kirim dokumen identitas resmi untuk ditinjau oleh tim platform."
        }
      />

      {isVerified && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Status verifikasi</p>
              <h2>Institusi terverifikasi</h2>
            </div>
            <span className="status-badge" data-status="open">
              Terverifikasi
            </span>
          </div>
          <Feedback tone="success">
            <p>
              <strong>Dokumen institusi Anda telah disetujui</strong>
              {verifiedAt ? ` pada ${formatLongDate(verifiedAt)}` : ""}.
            </p>
          </Feedback>
          {approvedSubmission?.reviewerNotes ? (
            <p className="muted-copy">
              <strong>Catatan peninjau:</strong> {approvedSubmission.reviewerNotes}
            </p>
          ) : null}
          <p className="muted-copy">
            Verifikasi ini berlaku seterusnya, jadi tidak ada dokumen baru yang perlu Anda kirim.
            Hubungi tim dukungan jika data institusi Anda berubah.
          </p>
        </section>
      )}

      {!isVerified && rejectionReason && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Status verifikasi</p>
              <h2>Verifikasi tidak berlaku</h2>
            </div>
            <span className="status-badge" data-status="closed">
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

      {!isVerified && loadingHistory && (
        <section className="content-section" aria-busy="true" aria-label="Memuat status verifikasi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
        </section>
      )}

      {!isVerified && !loadingHistory && pendingSubmission && (
        <section className="content-section verification-status-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Status verifikasi</p>
              <h2>Menunggu peninjauan</h2>
            </div>
            <span className="status-badge" data-status="closing">
              Diproses
            </span>
          </div>
          <p className="muted-copy">
            Dokumen yang Anda kirim pada {formatLongDate(pendingSubmission.submittedAt)} sedang
            ditinjau tim kami. Kami mengabari begitu ada keputusan.
          </p>
          <p className="muted-copy">
            Selama peninjauan berlangsung, Anda belum dapat mengirim pengajuan baru, karena peninjau
            menilai berkas yang sama dengan yang Anda kirim.
          </p>
        </section>
      )}

      {/* Submission form — rendered only while a submission can still change the outcome. */}
      {!loadingHistory && canSubmit && (
        <section className="content-section verification-submit-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Pengajuan baru</p>
              <h2>Dokumen verifikasi</h2>
            </div>
          </div>

          {/* The type is fixed at creation and cannot change — verification proves it, it does not
              choose it. Rendered as a read-only fact, not a control. */}
          <dl className="profile-detail-list">
            <div>
              <dt>Tipe institusi</dt>
              <dd>{TYPE_LABELS[institutionType]}</dd>
            </div>
          </dl>

          <div className="verification-documents">
            <p className="form-label">Dokumen yang dibutuhkan</p>
            {docFields.map((field, i) => (
              <div key={field.documentType} className="form-field verification-document-field">
                <label
                  htmlFor={`doc-${field.documentType}`}
                  className="form-label form-label-required"
                >
                  {DOCUMENT_TYPE_LABELS[field.documentType] ??
                    formatDisplayToken(field.documentType)}
                </label>
                <input
                  id={`doc-${field.documentType}`}
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setDocFields((prev) =>
                      prev.map((f, idx) =>
                        idx === i ? { ...f, file, fileName: file?.name ?? "" } : f,
                      ),
                    );
                  }}
                  className="form-file"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Submission history */}
      <section className="content-section verification-history-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Jejak pengajuan</p>
            <h2>Riwayat verifikasi</h2>
          </div>
          <span className="status-badge data-text">{submissions.length}</span>
        </div>
        {loadingHistory && (
          <div className="stack-sm" aria-label="Memuat riwayat verifikasi">
            <Skeleton variant="media" />
            <Skeleton variant="media" />
          </div>
        )}
        {!loadingHistory && submissions.length === 0 && (
          <EmptyState
            icon="check"
            title="Belum ada pengajuan."
            description={
              // A verified institution with no submission was verified directly by the platform
              // team, so "history will appear here" would be a promise nothing will keep.
              isVerified
                ? "Institusi ini diverifikasi langsung oleh tim platform, tanpa pengajuan dokumen."
                : "Riwayat peninjauan dokumen institusi akan muncul di sini."
            }
          />
        )}
        {!loadingHistory && submissions.length > 0 && (
          <div className="table-scroll">
            <table className="data-table verification-history-table">
              <thead>
                <tr>
                  <th>Tipe tujuan</th>
                  <th>Status</th>
                  <th>Dokumen</th>
                  <th>Dikirim</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td>{TYPE_LABELS[s.targetInstitutionType]}</td>
                    <td>
                      <span
                        className="status-badge"
                        data-status={
                          s.status === "approved"
                            ? "open"
                            : s.status === "rejected"
                              ? "closed"
                              : "closing"
                        }
                      >
                        {STATUS_LABELS[s.status]}
                      </span>
                    </td>
                    <td className="data-text">{s.documentCount}</td>
                    <td className="data-text">
                      {new Date(s.submittedAt).toLocaleDateString("id-ID")}
                    </td>
                    <td>{s.reviewerNotes ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FormActionBar>
        <IconButton
          icon="arrow-left"
          label="Panel institusi"
          onClick={() => router.push(`/institution/${institutionSlug}`)}
        />
        {canSubmit && !loadingHistory ? (
          <div className="form-action-bar-end">
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              loading={submitting}
              leadingIcon={<Icon name="upload" />}
            >
              Kirim dokumen
            </Button>
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
