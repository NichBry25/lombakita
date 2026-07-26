"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  EmptyState,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  SelectField,
  Skeleton,
} from "@/components/ui";
import { useModal } from "@/components/ui/primitives";
import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";
import { getCompetitionFieldLabel } from "@/lib/competitions/fields";
import { COMPETITION_MODE_OPTIONS } from "@/lib/competitions/modes";
import { capitalizeFirst, capitalizeWord } from "@/lib/text/capitalize";
import type { CompetitionCategory } from "@/server/db/schema";

type Category = CompetitionCategory;

type CompetitionStatus = "draft" | "published" | "archived";
type CompetitionMode = "individual" | "team" | "both";

type Competition = {
  id: string;
  institutionId: string;
  slug: string;
  title: string;
  description: string;
  status: CompetitionStatus;
  category: Category | null;
  mode: CompetitionMode | null;
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationStartAt: string | null;
  registrationEndAt: string | null;
  eventStartAt: string | null;
  eventEndAt: string | null;
  allowCancellation: boolean;
  cancellationCutoffDays: number | null;
};

type PublishValidationFailure = {
  field: string;
  code: "missing" | "out_of_order" | "not_in_future";
  message: string;
};

type Feedback =
  | { type: "success"; message: string }
  | { type: "error"; message: string; failures?: PublishValidationFailure[] }
  | null;

type FormSnapshot = {
  title: string;
  slug: string;
  description: string;
  category: string;
  mode: string;
  minTeamSize: string;
  maxTeamSize: string;
  regStart: string;
  regEnd: string;
  evtStart: string;
  evtEnd: string;
  allowCancellation: boolean;
  cutoffDays: string;
};

const extractError = async (
  response: Response,
): Promise<{
  message: string;
  code?: string;
  failures?: PublishValidationFailure[];
  blockedFields?: string[];
}> => {
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        details?: { failures?: PublishValidationFailure[]; blockedFields?: string[] };
      };
    };
    return {
      message: payload.error?.message ?? "Permintaan gagal diproses.",
      code: payload.error?.code,
      failures: payload.error?.details?.failures,
      blockedFields: payload.error?.details?.blockedFields,
    };
  } catch {
    return { message: "Permintaan gagal diproses." };
  }
};

const cutoffOrNull = (value: string): number | null => {
  if (value.trim() === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const toDateTimeInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local input expects YYYY-MM-DDTHH:mm without timezone.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fromDateTimeInput = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const intOrNull = (value: string): number | null => {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const snapshotEquals = (a: FormSnapshot, b: FormSnapshot): boolean =>
  a.title === b.title &&
  a.slug === b.slug &&
  a.description === b.description &&
  a.category === b.category &&
  a.mode === b.mode &&
  a.minTeamSize === b.minTeamSize &&
  a.maxTeamSize === b.maxTeamSize &&
  a.regStart === b.regStart &&
  a.regEnd === b.regEnd &&
  a.evtStart === b.evtStart &&
  a.evtEnd === b.evtEnd &&
  a.allowCancellation === b.allowCancellation &&
  a.cutoffDays === b.cutoffDays;

export const InstitutionCompetitionEditShell = ({
  institutionSlug,
  competitionId,
  isPersonal = false,
  children,
}: {
  institutionSlug: string;
  competitionId: string;
  // Step 6.5f.1 — a personal institution may only run individual-mode competitions. When true the
  // mode selector offers individual only (no team/both); the server guard
  // (assertPersonalInstitutionIndividualMode, 422) remains the authoritative enforcement.
  isPersonal?: boolean;
  // Additional authoring surfaces (e.g. the prizes editor) rendered inside the page shell so the
  // page keeps a single <main>. The parent page wires these because they carry their own save.
  children?: ReactNode;
}) => {
  const router = useRouter();
  const { openModal } = useModal();

  const [competition, setCompetition] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Publish shares the submit lock with Save but needs its own flag so the spinner lands on the
  // button that was actually pressed.
  const [isPublishing, setIsPublishing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("");
  const [mode, setMode] = useState<string>("");
  const [minTeamSize, setMinTeamSize] = useState("");
  const [maxTeamSize, setMaxTeamSize] = useState("");
  const [regStart, setRegStart] = useState("");
  const [regEnd, setRegEnd] = useState("");
  const [evtStart, setEvtStart] = useState("");
  const [evtEnd, setEvtEnd] = useState("");
  const [allowCancellation, setAllowCancellation] = useState(false);
  const [cutoffDays, setCutoffDays] = useState("");

  // F13: track the last-saved snapshot as state (not a ref) so comparisons are safe during render.
  const [savedSnapshot, setSavedSnapshot] = useState<FormSnapshot | null>(null);

  const currentSnapshot = (): FormSnapshot => ({
    title,
    slug,
    description,
    category,
    mode,
    minTeamSize,
    maxTeamSize,
    regStart,
    regEnd,
    evtStart,
    evtEnd,
    allowCancellation,
    cutoffDays,
  });

  const isDirty = savedSnapshot !== null && !snapshotEquals(currentSnapshot(), savedSnapshot);

  const load = useCallback(async () => {
    setIsLoading(true);
    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) {
      const { message } = await extractError(response);
      setFeedback({ type: "error", message });
      setIsLoading(false);
      return;
    }
    const data = (await response.json()) as { competition: Competition };
    setCompetition(data.competition);
    const loadedTitle = data.competition.title;
    const loadedSlug = data.competition.slug;
    const loadedDescription = data.competition.description ?? "";
    const loadedCategory = data.competition.category ?? "";
    const loadedMode = data.competition.mode ?? "";
    const loadedMinTeamSize = data.competition.minTeamSize?.toString() ?? "";
    const loadedMaxTeamSize = data.competition.maxTeamSize?.toString() ?? "";
    const loadedRegStart = toDateTimeInput(data.competition.registrationStartAt);
    const loadedRegEnd = toDateTimeInput(data.competition.registrationEndAt);
    const loadedEvtStart = toDateTimeInput(data.competition.eventStartAt);
    const loadedEvtEnd = toDateTimeInput(data.competition.eventEndAt);
    const loadedAllowCancellation = data.competition.allowCancellation ?? false;
    const loadedCutoffDays = data.competition.cancellationCutoffDays?.toString() ?? "";

    setTitle(loadedTitle);
    setSlug(loadedSlug);
    setDescription(loadedDescription);
    setCategory(loadedCategory);
    setMode(loadedMode);
    setMinTeamSize(loadedMinTeamSize);
    setMaxTeamSize(loadedMaxTeamSize);
    setRegStart(loadedRegStart);
    setRegEnd(loadedRegEnd);
    setEvtStart(loadedEvtStart);
    setEvtEnd(loadedEvtEnd);
    setAllowCancellation(loadedAllowCancellation);
    setCutoffDays(loadedCutoffDays);

    setSavedSnapshot({
      title: loadedTitle,
      slug: loadedSlug,
      description: loadedDescription,
      category: loadedCategory,
      mode: loadedMode,
      minTeamSize: loadedMinTeamSize,
      maxTeamSize: loadedMaxTeamSize,
      regStart: loadedRegStart,
      regEnd: loadedRegEnd,
      evtStart: loadedEvtStart,
      evtEnd: loadedEvtEnd,
      allowCancellation: loadedAllowCancellation,
      cutoffDays: loadedCutoffDays,
    });
    setIsLoading(false);
  }, [competitionId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // F13: warn browser on page unload/refresh when form is dirty.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const onSave = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);

    const patch: Record<string, unknown> = {
      title,
      slug,
      description,
      category: category === "" ? null : category,
      mode: mode === "" ? null : mode,
      minTeamSize: intOrNull(minTeamSize),
      maxTeamSize: intOrNull(maxTeamSize),
      registrationStartAt: fromDateTimeInput(regStart),
      registrationEndAt: fromDateTimeInput(regEnd),
      eventStartAt: fromDateTimeInput(evtStart),
      eventEndAt: fromDateTimeInput(evtEnd),
      allowCancellation,
      cancellationCutoffDays: allowCancellation ? cutoffOrNull(cutoffDays) : null,
    };

    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const { message, code, blockedFields } = await extractError(response);
      // F17 — a post-publish blocked or immutable-field edit is surfaced in a modal naming the
      // offending field(s) and why, per the shared-primitive rule.
      if (code === "competition_post_publish_blocked" || code === "competition_field_immutable") {
        const fields = blockedFields ?? [];
        openModal({
          title:
            code === "competition_field_immutable"
              ? "Bidang tidak dapat diubah"
              : "Perubahan ditolak",
          closeable: true,
          body: (
            <div className="stack-sm">
              <p className="muted-copy">
                {code === "competition_field_immutable"
                  ? "Bidang berikut tidak dapat diubah setelah kompetisi diterbitkan:"
                  : "Perubahan berikut akan membatalkan pendaftaran yang sudah ada, jadi tidak dapat disimpan:"}
              </p>
              <ul>
                {fields.map((f) => (
                  <li key={f}>{getCompetitionFieldLabel(f)}</li>
                ))}
              </ul>
              <p className="form-help">
                Untuk mengubah bidang ini, batalkan publikasi kompetisi terlebih dahulu (ini akan
                membatalkan semua pendaftaran yang ada).
              </p>
            </div>
          ),
          actions: [{ label: "Mengerti", variant: "primary", autoClose: true, onClick: () => {} }],
        });
        setFeedback({ type: "error", message });
        setIsSubmitting(false);
        return;
      }
      setFeedback({ type: "error", message });
      setIsSubmitting(false);
      return;
    }

    setFeedback({ type: "success", message: "Perubahan tersimpan." });
    setIsSubmitting(false);
    void load();
  };

  const onPublish = async () => {
    setIsSubmitting(true);
    setIsPublishing(true);
    setFeedback(null);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/publish`;
    try {
      const response = await fetch(url, { method: "POST", credentials: "include" });
      if (!response.ok) {
        const { message, failures } = await extractError(response);
        setFeedback({ type: "error", message, failures });
        return;
      }
      setFeedback({ type: "success", message: "Status diterbitkan (published)." });
      void load();
    } finally {
      setIsSubmitting(false);
      setIsPublishing(false);
    }
  };

  // F13: intercept in-app back navigation when form is dirty. Use competition slug for the
  // back URL (G6 page routes are slug-keyed); fall back to competitionId while data loads.
  const backUrl = `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competition?.slug ?? competitionId)}`;

  const handleBack = () => {
    if (!isDirty) {
      router.push(backUrl);
      return;
    }
    openModal({
      title: "Perubahan belum tersimpan",
      body: "Anda memiliki perubahan yang belum disimpan. Yakin ingin meninggalkan halaman ini?",
      closeable: true,
      actions: [
        {
          label: "Tinggalkan",
          variant: "danger",
          autoClose: true,
          onClick: () => {
            router.push(backUrl);
          },
        },
        {
          label: "Tetap di sini",
          variant: "secondary",
          autoClose: true,
          onClick: () => {},
        },
      ],
    });
  };

  if (isLoading) {
    return (
      <main className="page-shell app-page competition-form-page">
        <div className="stack-md" aria-label="Memuat formulir kompetisi">
          <Skeleton variant="title" />
          <Skeleton variant="media" />
          <Skeleton variant="media" />
        </div>
      </main>
    );
  }

  if (!competition) {
    return (
      <main className="page-shell app-page competition-form-page">
        <EmptyState
          icon="trophy"
          title="Kompetisi tidak ditemukan."
          description={feedback?.message ?? "Formulir kompetisi tidak dapat dimuat."}
          action={
            <ButtonLink href={`/institution/${institutionSlug}/competitions`} variant="outline">
              Kembali ke daftar
            </ButtonLink>
          }
        />
      </main>
    );
  }

  const isDraft = competition.status === "draft";
  const isEditable = competition.status === "draft" || competition.status === "published";
  // F17 — mode and team sizes are immutable once published; enforce at the field (disabled), with
  // the server 422 as a backstop.
  const isPublished = competition.status === "published";

  return (
    <main className="page-shell app-page competition-form-page">
      <PageHeader
        eyebrow="Editor kompetisi"
        title={competition.title}
        description={`/${competition.slug} · ${institutionSlug}`}
        actions={
          <span
            className="status-badge"
            data-status={
              isPublished ? "open" : competition.status === "archived" ? "closed" : "closing"
            }
          >
            {capitalizeWord(competition.status)}
          </span>
        }
      />

      {competition.status === "published" ? (
        <p className="feedback" data-tone="info">
          Kompetisi ini sudah terbit. Perubahan yang memengaruhi peserta akan mengirim notifikasi.
          Perubahan yang membatalkan pendaftaran yang ada akan ditolak.
        </p>
      ) : null}

      {!isEditable ? (
        <p className="feedback" data-tone="error">
          Kompetisi berstatus <code>{capitalizeWord(competition.status)}</code> tidak dapat diubah.
        </p>
      ) : (
        <form onSubmit={onSave} className="competition-edit-form">
          <section className="content-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Identitas publik</p>
                <h2>Informasi utama</h2>
              </div>
            </div>
            <label className="form-field">
              <span className="form-label form-label-required">Judul</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                minLength={5}
                maxLength={200}
                className="form-input"
              />
            </label>
            <label className="form-field">
              <span className="form-label">Slug</span>
              <input
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="form-input"
              />
              <span className="form-help">Gunakan huruf kecil, angka, dan tanda hubung.</span>
            </label>
            <label className="form-field">
              <span className="form-label">Deskripsi</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={10000}
                className="form-textarea"
              />
            </label>
            <div className="form-field">
              <span className="form-label" id="competition-category-label">
                Kategori
              </span>
              <SelectField
                label="Kategori"
                id="competition-category-label"
                value={category}
                placeholder="Pilih"
                options={[...COMPETITION_CATEGORY_OPTIONS]}
                onChange={setCategory}
              />
            </div>
          </section>

          <section className="content-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Format partisipasi</p>
                <h2>Mode dan ukuran tim</h2>
              </div>
            </div>
            {isPublished ? (
              <p className="form-help">
                Format peserta dan ukuran tim tidak dapat diubah setelah kompetisi terbit.
              </p>
            ) : null}
            {isPersonal ? (
              <p className="feedback" data-tone="info">
                Institusi personal hanya dapat menjalankan kompetisi mode individu.
              </p>
            ) : null}
            <div className="form-field">
              <span className="form-label" id="competition-mode-label">
                Mode
              </span>
              {/* Personal institutions are individual-only (Step 6.5f.1). */}
              <SelectField
                label="Mode"
                id="competition-mode-label"
                value={mode}
                disabled={isPublished}
                placeholder="Pilih"
                options={
                  isPersonal
                    ? COMPETITION_MODE_OPTIONS.filter((option) => option.value === "individual")
                    : [...COMPETITION_MODE_OPTIONS]
                }
                onChange={(newMode) => {
                  setMode(newMode);
                  // Mode-driven team-size behaviour:
                  //   individual → fixed 1/1, both fields disabled
                  //   team       → default 2/2, both fields editable
                  //   both       → min fixed at 1 (disabled), max editable (default 2)
                  if (newMode === "individual") {
                    setMinTeamSize("1");
                    setMaxTeamSize("1");
                  } else if (newMode === "team") {
                    setMinTeamSize("2");
                    setMaxTeamSize("2");
                  } else if (newMode === "both") {
                    setMinTeamSize("1");
                    if (!maxTeamSize || Number.parseInt(maxTeamSize, 10) < 1) {
                      setMaxTeamSize("2");
                    }
                  }
                }}
              />
            </div>
            <div className="form-grid">
              <label className="form-field">
                <span className="form-label">Min. anggota tim</span>
                <input
                  type="number"
                  value={minTeamSize}
                  onChange={(e) => setMinTeamSize(e.target.value)}
                  min={mode === "team" ? 2 : 1}
                  // Min is fixed for individual (1) and both (1); only team allows editing min.
                  // Immutable once published.
                  disabled={isPublished || mode === "individual" || mode === "both"}
                  className="form-input"
                />
              </label>
              <label className="form-field">
                <span className="form-label">Maks. anggota tim</span>
                <input
                  type="number"
                  value={maxTeamSize}
                  onChange={(e) => setMaxTeamSize(e.target.value)}
                  min={1}
                  // Max is fixed for individual (1); team and both allow editing max.
                  // Immutable once published.
                  disabled={isPublished || mode === "individual"}
                  className="form-input"
                />
              </label>
            </div>
          </section>

          <section className="content-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Linimasa</p>
                <h2>Jadwal kompetisi</h2>
              </div>
            </div>
            <div className="form-grid">
              <label className="form-field">
                <span className="form-label">Pendaftaran mulai</span>
                <input
                  type="datetime-local"
                  value={regStart}
                  onChange={(e) => setRegStart(e.target.value)}
                  className="form-input"
                />
              </label>
              <label className="form-field">
                <span className="form-label">Pendaftaran berakhir</span>
                <input
                  type="datetime-local"
                  value={regEnd}
                  onChange={(e) => setRegEnd(e.target.value)}
                  className="form-input"
                />
              </label>
              <label className="form-field">
                <span className="form-label">Acara mulai</span>
                <input
                  type="datetime-local"
                  value={evtStart}
                  onChange={(e) => setEvtStart(e.target.value)}
                  className="form-input"
                />
              </label>
              <label className="form-field">
                <span className="form-label">Acara berakhir</span>
                <input
                  type="datetime-local"
                  value={evtEnd}
                  onChange={(e) => setEvtEnd(e.target.value)}
                  className="form-input"
                />
              </label>
            </div>
          </section>

          <fieldset className="content-section competition-policy-fieldset">
            <legend className="sr-only">Kebijakan pembatalan peserta</legend>
            <div className="section-heading">
              <div>
                <h2>Kebijakan pembatalan peserta</h2>
              </div>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={allowCancellation}
                onChange={(e) => setAllowCancellation(e.target.checked)}
              />
              <span>Izinkan peserta membatalkan pendaftaran sendiri</span>
            </label>
            <label className="form-field">
              <span className="form-label">Batas pembatalan (hari sebelum acara mulai)</span>
              <input
                type="number"
                value={cutoffDays}
                onChange={(e) => setCutoffDays(e.target.value)}
                min={0}
                disabled={!allowCancellation}
                className="form-input"
              />
            </label>
          </fieldset>
        </form>
      )}

      {feedback ? (
        <div role="status" className="feedback" data-tone={feedback.type}>
          <p>{feedback.message}</p>
          {feedback.type === "error" && feedback.failures && feedback.failures.length > 0 ? (
            <ul>
              {feedback.failures.map((f) => (
                <li key={`${f.field}-${f.code}`}>
                  <strong>{getCompetitionFieldLabel(f.field)}</strong> —{" "}
                  {capitalizeFirst(f.message)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {children}

      <FormActionBar>
        <IconButton icon="arrow-left" label="Kembali ke aksi status" onClick={handleBack} />
        {isEditable ? (
          <div className="form-action-bar-end">
            <span className="record-meta" data-dirty={isDirty ? "true" : undefined}>
              {isDirty ? "Perubahan belum disimpan" : "Semua perubahan tersimpan"}
            </span>
            <Button
              type="button"
              onClick={() => onSave()}
              loading={isSubmitting}
              leadingIcon={<Icon name="save" />}
            >
              Simpan
            </Button>
            {isDraft ? (
              <Button
                variant="secondary"
                type="button"
                onClick={onPublish}
                loading={isPublishing}
                disabled={isSubmitting}
              >
                Publish
              </Button>
            ) : null}
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
