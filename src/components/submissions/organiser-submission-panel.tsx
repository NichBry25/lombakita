"use client";

import { useState } from "react";
import { Button, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { formatFileSize } from "@/lib/text/format-file-size";

export type OrganiserSubmissionView = {
  fileName: string;
  fileSizeBytes: number | null;
  version: number;
  finalized: boolean;
  submittedAt: string;
  canRenderInline: boolean;
};

type PanelProps = {
  institutionSlug: string;
  competitionId: string;
  registrationId: string;
  submission: OrganiserSubmissionView | null;
};

const formatTimestamp = (isoDate: string): string =>
  new Date(isoDate).toLocaleString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The submitted work, on one participant's review page.
 *
 * A file that is not finalized is still shown and still openable — the participant may replace it
 * until they finalize, so what a reviewer sees is the current version, labelled as such. Hiding an
 * unfinalized entry would leave a reviewer unable to check work that is in fact ready.
 */
export function OrganiserSubmissionPanel({
  institutionSlug,
  competitionId,
  registrationId,
  submission,
}: PanelProps) {
  const { addToast } = useToast();
  const [pending, setPending] = useState<"inline" | "attachment" | null>(null);

  const openFile = async (disposition: "inline" | "attachment") => {
    setPending(disposition);
    try {
      const response = await fetch(
        `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/registrations/${registrationId}/submission/file?disposition=${disposition}`,
        { credentials: "include" },
      );

      if (!response.ok) {
        addToast({ type: "error", message: "Gagal membuka berkas. Coba lagi." });
        return;
      }

      const { url } = (await response.json()) as { url: string };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      addToast({ type: "error", message: "Gagal membuka berkas karena gangguan koneksi." });
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="content-section">
      <div className="section-heading">
        <h2>Karya peserta</h2>
      </div>

      {submission === null ? (
        <p className="muted-copy">
          Peserta ini belum mengunggah karya. Berkasnya akan muncul di sini begitu diunggah.
        </p>
      ) : (
        <ul className="record-list">
          <li className="record-row">
            <div className="record-row-main">
              <div className="section-heading">
                <p className="record-row-title">{submission.fileName}</p>
                <span
                  className="status-badge"
                  data-status={submission.finalized ? "open" : "closing"}
                >
                  {submission.finalized ? "Finalisasi" : "Belum final"}
                </span>
              </div>

              <span className="record-meta">
                {submission.fileSizeBytes != null
                  ? `${formatFileSize(submission.fileSizeBytes)} · `
                  : ""}
                Versi {submission.version} · Diunggah{" "}
                <time dateTime={submission.submittedAt} className="data-text">
                  {formatTimestamp(submission.submittedAt)}
                </time>
              </span>

              {submission.finalized ? null : (
                <span className="record-meta">
                  Peserta masih dapat mengganti berkas ini sampai mereka memfinalisasi.
                </span>
              )}
            </div>

            <div className="record-actions">
              {submission.canRenderInline ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={pending === "inline"}
                  aria-label={`Lihat berkas ${submission.fileName}`}
                  leadingIcon={<Icon name="eye" size="sm" aria-hidden="true" />}
                  onClick={() => void openFile("inline")}
                >
                  Lihat
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={pending === "attachment"}
                aria-label={`Unduh berkas ${submission.fileName}`}
                leadingIcon={<Icon name="download" size="sm" aria-hidden="true" />}
                onClick={() => void openFile("attachment")}
              >
                Unduh
              </Button>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}
