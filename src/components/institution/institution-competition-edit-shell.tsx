"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/primitives";

const CATEGORY_OPTIONS = [
  "technology",
  "science",
  "business",
  "creative_arts",
  "social_humanities",
  "sports",
  "academic",
  "other",
] as const;
type Category = (typeof CATEGORY_OPTIONS)[number];

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
};

const extractError = async (
  response: Response,
): Promise<{ message: string; failures?: PublishValidationFailure[] }> => {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string; details?: { failures?: PublishValidationFailure[] } };
    };
    return {
      message: payload.error?.message ?? "Permintaan gagal diproses.",
      failures: payload.error?.details?.failures,
    };
  } catch {
    return { message: "Permintaan gagal diproses." };
  }
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
  a.evtEnd === b.evtEnd;

export const InstitutionCompetitionEditShell = ({
  institutionSlug,
  competitionId,
}: {
  institutionSlug: string;
  competitionId: string;
}) => {
  const router = useRouter();
  const { openModal } = useModal();

  const [competition, setCompetition] = useState<Competition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  // F13: track the last-saved snapshot as state (not a ref) so comparisons are safe during render.
  const [savedSnapshot, setSavedSnapshot] = useState<FormSnapshot | null>(null);

  const currentSnapshot = (): FormSnapshot => ({
    title, slug, description, category, mode,
    minTeamSize, maxTeamSize, regStart, regEnd, evtStart, evtEnd,
  });

  const isDirty =
    savedSnapshot !== null &&
    !snapshotEquals(currentSnapshot(), savedSnapshot);

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

    setSavedSnapshot({
      title: loadedTitle, slug: loadedSlug, description: loadedDescription,
      category: loadedCategory, mode: loadedMode, minTeamSize: loadedMinTeamSize,
      maxTeamSize: loadedMaxTeamSize, regStart: loadedRegStart, regEnd: loadedRegEnd,
      evtStart: loadedEvtStart, evtEnd: loadedEvtEnd,
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
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const onSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    };

    const response = await fetch(`/api/v1/competitions/${encodeURIComponent(competitionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const { message } = await extractError(response);
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
    setFeedback(null);
    const url = `/api/v1/institutions/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}/publish`;
    const response = await fetch(url, { method: "POST", credentials: "include" });
    if (!response.ok) {
      const { message, failures } = await extractError(response);
      setFeedback({ type: "error", message, failures });
      setIsSubmitting(false);
      return;
    }
    setFeedback({ type: "success", message: "Status diterbitkan (published)." });
    setIsSubmitting(false);
    void load();
  };

  // F13: intercept in-app back navigation when form is dirty.
  const backUrl = `/institution/${encodeURIComponent(institutionSlug)}/competitions/${encodeURIComponent(competitionId)}`;

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
          onClick: () => { router.push(backUrl); },
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
      <main style={{ padding: 24 }}>
        <p>Memuat...</p>
      </main>
    );
  }

  if (!competition) {
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: "#b00" }}>{feedback?.message ?? "Kompetisi tidak ditemukan."}</p>
      </main>
    );
  }

  const isDraft = competition.status === "draft";

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Edit Draf — {competition.title}</h1>
      <p>
        Status: <strong>{competition.status}</strong> · Slug: <code>{competition.slug}</code> ·
        Institusi: <code>{institutionSlug}</code>
      </p>

      {!isDraft ? (
        <p style={{ color: "#b00", marginTop: 12 }}>
          Hanya kompetisi berstatus <code>draft</code> yang dapat diubah. Status saat ini:{" "}
          <strong>{competition.status}</strong>. Gunakan tindakan{" "}
          <em>Unpublish (kembali ke draft)</em> di halaman aksi status terlebih dahulu.
        </p>
      ) : (
        <form onSubmit={onSave} style={{ marginTop: 16 }}>
          <label style={{ display: "block", marginBottom: 8 }}>
            Judul
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={5}
              maxLength={200}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Slug (^[a-z0-9-]+$)
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Deskripsi
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={10000}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Kategori
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ display: "block" }}
            >
              <option value="">— kosong —</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Mode
            <select
              value={mode}
              onChange={(e) => {
                const newMode = e.target.value;
                setMode(newMode);
                if (newMode === "individual") {
                  setMinTeamSize("1");
                  setMaxTeamSize("1");
                }
              }}
              style={{ display: "block" }}
            >
              <option value="">— kosong —</option>
              <option value="individual">individual</option>
              <option value="team">team</option>
              <option value="both">both</option>
            </select>
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Min. anggota tim
            <input
              type="number"
              value={minTeamSize}
              onChange={(e) => setMinTeamSize(e.target.value)}
              min={1}
              disabled={mode === "individual"}
              style={{ display: "block" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Maks. anggota tim
            <input
              type="number"
              value={maxTeamSize}
              onChange={(e) => setMaxTeamSize(e.target.value)}
              min={1}
              disabled={mode === "individual"}
              style={{ display: "block" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Pendaftaran mulai
            <input
              type="datetime-local"
              value={regStart}
              onChange={(e) => setRegStart(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Pendaftaran berakhir (deadline, harus di masa depan)
            <input
              type="datetime-local"
              value={regEnd}
              onChange={(e) => setRegEnd(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Acara mulai
            <input
              type="datetime-local"
              value={evtStart}
              onChange={(e) => setEvtStart(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8 }}>
            Acara berakhir
            <input
              type="datetime-local"
              value={evtEnd}
              onChange={(e) => setEvtEnd(e.target.value)}
              style={{ display: "block" }}
            />
          </label>
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Menyimpan..." : "Simpan"}
          </button>{" "}
          <button type="button" onClick={onPublish} disabled={isSubmitting}>
            Publish
          </button>
        </form>
      )}

      <p style={{ marginTop: 16 }}>
        <button
          type="button"
          onClick={handleBack}
          style={{ background: "none", border: "none", color: "#355795", cursor: "pointer", padding: 0, fontSize: "inherit" }}
        >
          ← Kembali ke aksi status
        </button>
      </p>

      {feedback ? (
        <div
          role="status"
          style={{
            color: feedback.type === "error" ? "#b00" : "#070",
            marginTop: 16,
            padding: 8,
            border: `1px solid ${feedback.type === "error" ? "#b00" : "#070"}`,
          }}
        >
          <p style={{ margin: 0 }}>{feedback.message}</p>
          {feedback.type === "error" && feedback.failures && feedback.failures.length > 0 ? (
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              {feedback.failures.map((f) => (
                <li key={`${f.field}-${f.code}`}>
                  <strong>{f.field}</strong> — {f.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </main>
  );
};
