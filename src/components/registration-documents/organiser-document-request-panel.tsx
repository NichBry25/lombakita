"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, CheckboxField, Feedback, Icon, IconButton } from "@/components/ui";
import { useModal, useToast } from "@/components/ui/primitives";
import {
  DOCUMENT_REQUEST_STATUS_LABELS,
  DOCUMENT_REQUEST_STATUS_TONES,
  type RegistrationDocumentDisplayStatus,
} from "@/lib/registration-documents/request-status";
import { formatFileSize } from "@/lib/text/format-file-size";

export type OrganiserDocumentRequest = {
  id: string;
  title: string;
  instructions: string | null;
  dueAt: string;
  status: "requested" | "submitted" | "accepted" | "rejected" | "cancelled";
  displayStatus: RegistrationDocumentDisplayStatus;
  isOverdue: boolean;
  isLate: boolean;
  reviewNote: string | null;
  revisionCount: number;
  files: Array<{
    id: string;
    originalFileName: string;
    fileSizeBytes: number;
    createdAt: string;
  }>;
};

type PanelProps = {
  institutionSlug: string;
  competitionId: string;
  registrationId: string;
  requests: OrganiserDocumentRequest[];
};

const formatDeadline = (isoDate: string): string =>
  new Date(isoDate).toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Default deadline offered on the create form and on a reopening rejection: seven days out, as a
// datetime-local value.
const defaultDeadlineValue = (): string => {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const isOpen = (status: OrganiserDocumentRequest["status"]): boolean =>
  status === "requested" || status === "submitted";

/**
 * The organizer's side of participant document verification, on one participant's page.
 *
 * A request is orthogonal to the participant's standing: nothing here changes their registration,
 * their submission, or their result. Rejecting a document records a verdict — acting on it (for
 * instance unpublishing a result) stays a separate, deliberate step elsewhere.
 */
export function OrganiserDocumentRequestPanel({
  institutionSlug,
  competitionId,
  registrationId,
  requests,
}: PanelProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const { openModal, closeModal } = useModal();

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dueAt, setDueAt] = useState(defaultDeadlineValue);
  const [creating, setCreating] = useState(false);
  // Keyed by request id so only the control that was pressed spins.
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);

  const hasOpenRequest = requests.some((request) => isOpen(request.status));

  const requestBase = `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}`;

  const createRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;

    if (title.trim().length === 0) {
      addToast({ type: "error", message: "Isi nama dokumen yang diminta." });
      return;
    }

    setCreating(true);
    try {
      const response = await fetch(
        `${requestBase}/registrations/${registrationId}/document-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            title: title.trim(),
            instructions: instructions.trim() || null,
            dueAt: new Date(dueAt).toISOString(),
          }),
        },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Gagal mengirim permintaan. Coba lagi.",
        });
        return;
      }

      addToast({ type: "success", message: "Permintaan dokumen terkirim." });
      setTitle("");
      setInstructions("");
      setDueAt(defaultDeadlineValue());
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal mengirim permintaan karena gangguan koneksi." });
    } finally {
      setCreating(false);
    }
  };

  const patchRequest = async (
    requestId: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) => {
    setPendingRequestId(requestId);
    try {
      const response = await fetch(`${requestBase}/document-requests/${requestId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        addToast({
          type: "error",
          message: payload?.error?.message ?? "Tindakan gagal. Muat ulang halaman lalu coba lagi.",
        });
        return;
      }

      addToast({ type: "success", message: successMessage });
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Tindakan gagal karena gangguan koneksi." });
    } finally {
      setPendingRequestId(null);
    }
  };

  const openFile = async (
    requestId: string,
    fileId: string,
    disposition: "inline" | "attachment",
  ) => {
    try {
      const response = await fetch(
        `${requestBase}/document-requests/${requestId}/files/${fileId}?disposition=${disposition}`,
        { credentials: "include" },
      );

      if (!response.ok) {
        addToast({ type: "error", message: "Gagal membuka dokumen. Coba lagi." });
        return;
      }

      const { url } = (await response.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      addToast({ type: "error", message: "Gagal membuka dokumen karena gangguan koneksi." });
    }
  };

  // Rejecting is reachable whether or not a file was uploaded: a document that is present, on time
  // and legible may still be refused. The form owns its own submit, so the modal carries no actions.
  const confirmReject = (request: OrganiserDocumentRequest) => {
    openModal({
      title: "Tolak dokumen",
      body: (
        <RejectForm
          request={request}
          onSubmit={(body) => {
            closeModal();
            void patchRequest(request.id, body, "Dokumen ditolak.");
          }}
          onCancel={closeModal}
        />
      ),
      actions: [],
    });
  };

  const confirmExtend = (request: OrganiserDocumentRequest) => {
    openModal({
      title: "Perpanjang tenggat",
      body: (
        <DeadlineForm
          onSubmit={(dueAtIso) => {
            closeModal();
            void patchRequest(
              request.id,
              { action: "extend", dueAt: dueAtIso },
              "Tenggat diperpanjang.",
            );
          }}
          onCancel={closeModal}
        />
      ),
      actions: [],
    });
  };

  const confirmCancel = (request: OrganiserDocumentRequest) => {
    openModal({
      title: "Tarik permintaan",
      body: `Permintaan "${request.title}" akan ditarik. Peserta tidak perlu lagi mengunggah dokumen.`,
      actions: [
        { label: "Batal", variant: "secondary", onClick: closeModal },
        {
          label: "Tarik permintaan",
          variant: "danger",
          onClick: () => {
            closeModal();
            void patchRequest(request.id, { action: "cancel" }, "Permintaan ditarik.");
          },
        },
      ],
    });
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>Verifikasi dokumen</h2>
      </div>
      <p className="muted-copy">
        Minta bukti kelayakan dari peserta ini. Permintaan tidak menghentikan pendaftaran, karya,
        atau hasil mereka. Anda yang memutuskan tindak lanjutnya.
      </p>

      {requests.length > 0 ? (
        <ul className="record-list">
          {requests.map((request) => (
            <li className="record-row" key={request.id}>
              <div className="record-row-main">
                <div className="section-heading">
                  <p className="record-row-title">{request.title}</p>
                  <span
                    className="status-badge"
                    data-status={DOCUMENT_REQUEST_STATUS_TONES[request.displayStatus]}
                  >
                    {DOCUMENT_REQUEST_STATUS_LABELS[request.displayStatus]}
                  </span>
                </div>

                <span className="record-meta">
                  Tenggat{" "}
                  <time dateTime={request.dueAt} className="data-text">
                    {formatDeadline(request.dueAt)}
                  </time>
                  {request.isLate ? " · Diunggah terlambat" : ""}
                  {request.revisionCount > 0 ? ` · Penolakan ke-${request.revisionCount}` : ""}
                </span>

                {request.reviewNote ? (
                  <span className="record-meta">Catatan: {request.reviewNote}</span>
                ) : null}

                {request.isOverdue ? (
                  <Feedback tone="warning">
                    Tenggat lewat tanpa unggahan. Anda dapat menolak, memperpanjang tenggat, atau
                    membiarkannya.
                  </Feedback>
                ) : null}

                {request.files.length > 0 ? (
                  <ul className="record-list">
                    {request.files.map((file) => (
                      <li className="record-row" key={file.id}>
                        <div className="record-row-main">
                          <p className="record-row-title">{file.originalFileName}</p>
                          <span className="record-meta">{formatFileSize(file.fileSizeBytes)}</span>
                        </div>
                        <div className="record-actions">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            leadingIcon={<Icon name="eye" size="sm" aria-hidden="true" />}
                            onClick={() => void openFile(request.id, file.id, "inline")}
                          >
                            Lihat
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            leadingIcon={<Icon name="download" size="sm" aria-hidden="true" />}
                            onClick={() => void openFile(request.id, file.id, "attachment")}
                          >
                            Unduh
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {isOpen(request.status) ? (
                  <div className="record-actions">
                    <Button
                      type="button"
                      loading={pendingRequestId === request.id}
                      disabled={request.status !== "submitted"}
                      onClick={() =>
                        void patchRequest(
                          request.id,
                          { action: "review", verdict: "accept" },
                          "Dokumen diterima.",
                        )
                      }
                    >
                      Terima
                    </Button>
                    <Button type="button" variant="danger" onClick={() => confirmReject(request)}>
                      Tolak
                    </Button>
                    <Button type="button" variant="outline" onClick={() => confirmExtend(request)}>
                      Perpanjang tenggat
                    </Button>
                    <IconButton
                      label={`Tarik permintaan ${request.title}`}
                      icon="close"
                      variant="ghost"
                      onClick={() => confirmCancel(request)}
                    />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {hasOpenRequest ? (
        <p className="muted-copy">
          Peserta ini sudah memiliki permintaan yang berjalan. Selesaikan permintaan tersebut
          sebelum membuat yang baru.
        </p>
      ) : (
        <form className="auth-form" onSubmit={createRequest}>
          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="document-request-title">
              Dokumen yang diminta
            </label>
            <input
              id="document-request-title"
              className="form-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              required
              placeholder="Kartu pelajar"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="document-request-instructions">
              Petunjuk
            </label>
            <textarea
              id="document-request-instructions"
              className="form-input"
              rows={3}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={2000}
              placeholder="Pastikan nama dan nama sekolah terbaca jelas."
            />
            <p className="form-help">
              Jelaskan apa yang dianggap sah. Peserta melihat teks ini apa adanya.
            </p>
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="document-request-due">
              Tenggat
            </label>
            <input
              id="document-request-due"
              className="form-input"
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
              required
            />
            <p className="form-help">
              Tenggat yang lewat tanpa unggahan ditandai sebagai tidak dipenuhi. Tidak ada tindakan
              otomatis.
            </p>
          </div>

          <Button type="submit" loading={creating}>
            Minta dokumen
          </Button>
        </form>
      )}
    </section>
  );
}

function RejectForm({
  request,
  onSubmit,
  onCancel,
}: {
  request: OrganiserDocumentRequest;
  onSubmit: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [allowReupload, setAllowReupload] = useState(true);
  const [dueAt, setDueAt] = useState(defaultDeadlineValue);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      action: "review",
      verdict: "reject",
      note: note.trim(),
      allowReupload,
      ...(allowReupload ? { dueAt: new Date(dueAt).toISOString() } : {}),
    });
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <p className="muted-copy">
        Alasan ini ditampilkan kepada peserta sebagai isi halaman, bukan notifikasi sesaat.
      </p>
      <div className="form-field">
        <label className="form-label form-label-required" htmlFor={`reject-note-${request.id}`}>
          Alasan penolakan
        </label>
        <textarea
          id={`reject-note-${request.id}`}
          className="form-input"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          required
        />
      </div>

      <div className="form-field">
        <CheckboxField
          id={`reject-reupload-${request.id}`}
          checked={allowReupload}
          onChange={(event) => setAllowReupload(event.target.checked)}
        >
          Izinkan unggah ulang
        </CheckboxField>
        <p className="form-help">
          Sebagian besar penolakan hanya soal foto yang tidak terbaca. Hilangkan centang ini bila
          permintaan harus ditutup permanen.
        </p>
      </div>

      {allowReupload ? (
        <div className="form-field">
          <label className="form-label form-label-required" htmlFor={`reject-due-${request.id}`}>
            Tenggat baru
          </label>
          <input
            id={`reject-due-${request.id}`}
            className="form-input"
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            required
          />
        </div>
      ) : null}

      <div className="record-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Batal
        </Button>
        <Button type="submit" variant="danger">
          Tolak dokumen
        </Button>
      </div>
    </form>
  );
}

function DeadlineForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (dueAtIso: string) => void;
  onCancel: () => void;
}) {
  const [dueAt, setDueAt] = useState(defaultDeadlineValue);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new Date(dueAt).toISOString());
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="form-field">
        <label className="form-label form-label-required" htmlFor="extend-due">
          Tenggat baru
        </label>
        <input
          id="extend-due"
          className="form-input"
          type="datetime-local"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
          required
        />
      </div>
      <div className="record-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Batal
        </Button>
        <Button type="submit">Perpanjang</Button>
      </div>
    </form>
  );
}
