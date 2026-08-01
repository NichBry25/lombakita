"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";

export type BatchTarget = {
  registrationId: string;
  label: string;
  hasOpenRequest: boolean;
};

const defaultDeadlineValue = (): string => {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

/**
 * Asks several participants for the same document in one go.
 *
 * The realistic ask is "the ninety-six who advanced", not one person at a time, so this exists to
 * keep the organizer's effort proportional to their interest rather than to the size of the
 * registration list.
 *
 * Two selection scopes, because the table paginates and the ask usually does not: the checkboxes
 * cover the participants on screen, while "select all" reaches the whole competition —
 * `allEligibleIds` is computed server-side with the same predicate the batch enforces, so
 * selecting everyone can never produce requests that are silently skipped. Participants already
 * holding an open request are listed but not selectable, and are absent from that set.
 */
export function BatchDocumentRequestForm({
  institutionSlug,
  competitionId,
  targets,
  allEligibleIds,
  maxBatchSize,
}: {
  institutionSlug: string;
  competitionId: string;
  targets: BatchTarget[];
  allEligibleIds: string[];
  maxBatchSize: number;
}) {
  const router = useRouter();
  const { addToast } = useToast();

  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dueAt, setDueAt] = useState(defaultDeadlineValue);
  const [busy, setBusy] = useState(false);

  const selectable = targets.filter((target) => !target.hasOpenRequest);

  const toggle = (registrationId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(registrationId)) next.delete(registrationId);
      else next.add(registrationId);
      return next;
    });
  };

  // Selects every eligible participant in the competition, not just the current page. Truncated at
  // the server's batch cap rather than refused, so a very large competition is done in a few
  // passes instead of not at all — the message says so rather than silently dropping people.
  const selectAllEligible = () => {
    if (allEligibleIds.length > maxBatchSize) {
      addToast({
        type: "info",
        message: `${maxBatchSize} peserta pertama dipilih dari ${allEligibleIds.length}. Kirim batch ini, lalu ulangi untuk sisanya.`,
      });
    }
    setSelected(new Set(allEligibleIds.slice(0, maxBatchSize)));
  };

  const selectPage = () => {
    setSelected((current) => {
      const pageIds = selectable.map((target) => target.registrationId);
      const allOnPageSelected = pageIds.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of pageIds) {
        if (allOnPageSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (selected.size === 0) {
      addToast({ type: "error", message: "Pilih setidaknya satu peserta." });
      return;
    }
    if (title.trim().length === 0) {
      addToast({ type: "error", message: "Isi nama dokumen yang diminta." });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/institutions/${institutionSlug}/competitions/${competitionId}/document-requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            registrationIds: [...selected],
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

      const outcome = (await response.json()) as {
        created: unknown[];
        skipped: unknown[];
      };

      addToast({
        type: "success",
        message:
          outcome.skipped.length > 0
            ? `${outcome.created.length} permintaan terkirim, ${outcome.skipped.length} dilewati.`
            : `${outcome.created.length} permintaan terkirim.`,
      });

      setSelected(new Set());
      setTitle("");
      setInstructions("");
      setDueAt(defaultDeadlineValue());
      setExpanded(false);
      router.refresh();
    } catch {
      addToast({ type: "error", message: "Gagal mengirim permintaan karena gangguan koneksi." });
    } finally {
      setBusy(false);
    }
  };

  if (targets.length === 0) return null;

  return (
    <section className="content-section" aria-label="Minta dokumen dari beberapa peserta">
      <div className="section-heading">
        <h2>Minta dokumen</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls="batch-document-request"
        >
          {expanded ? "Tutup" : "Buka"}
        </Button>
      </div>
      <p className="muted-copy">
        Minta bukti kelayakan dari peserta yang Anda pilih. Permintaan tidak menghentikan
        pendaftaran atau karya mereka.
      </p>

      {expanded ? (
        <form id="batch-document-request" className="auth-form" onSubmit={submit}>
          <fieldset className="form-field">
            <legend className="form-label form-label-required">
              Peserta ({selected.size} dipilih)
            </legend>
            <div className="record-actions">
              {allEligibleIds.length > 0 ? (
                <Button type="button" variant="outline" size="sm" onClick={selectAllEligible}>
                  Pilih semua peserta ({allEligibleIds.length})
                </Button>
              ) : null}
              {selectable.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={selectPage}>
                  Pilih halaman ini ({selectable.length})
                </Button>
              ) : null}
              {selected.size > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  Kosongkan pilihan
                </Button>
              ) : null}
            </div>
            {selected.size > selectable.length ? (
              <p className="form-help">
                {selected.size} peserta dipilih, termasuk peserta di halaman lain.
              </p>
            ) : null}
            <ul className="record-list">
              {targets.map((target) => (
                <li className="record-row" key={target.registrationId}>
                  <label className="form-label" htmlFor={`batch-${target.registrationId}`}>
                    <input
                      id={`batch-${target.registrationId}`}
                      type="checkbox"
                      checked={selected.has(target.registrationId)}
                      disabled={target.hasOpenRequest}
                      onChange={() => toggle(target.registrationId)}
                    />{" "}
                    {target.label}
                    {target.hasOpenRequest ? (
                      <span className="record-meta"> (sudah ada permintaan berjalan)</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="batch-title">
              Dokumen yang diminta
            </label>
            <input
              id="batch-title"
              className="form-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              required
              placeholder="Kartu pelajar"
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="batch-instructions">
              Petunjuk
            </label>
            <textarea
              id="batch-instructions"
              className="form-input"
              rows={3}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={2000}
              placeholder="Pastikan nama dan nama sekolah terbaca jelas."
            />
          </div>

          <div className="form-field">
            <label className="form-label form-label-required" htmlFor="batch-due">
              Tenggat
            </label>
            <input
              id="batch-due"
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

          <Button type="submit" loading={busy}>
            Minta dokumen
          </Button>
        </form>
      ) : null}
    </section>
  );
}
