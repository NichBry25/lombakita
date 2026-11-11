"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckboxField, Feedback } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  describePartLoadFailure,
  useCompetitionEditorPart,
  type CompetitionPartSaveResult,
} from "@/components/institution/competition-editor-parts";
import { ALLOWED_COMPETITION_TAGS } from "@/lib/competitions/tags";
import { errorMessageFor } from "@/lib/errors/error-copy";
import { readErrorCode, sessionFetch } from "@/lib/session/session-fetch";

const SAVE_ERROR_COPY: Partial<Record<string, string>> = {
  forbidden: "Anda tidak memiliki akses ke kompetisi institusi ini.",
  competition_tags_invalid_payload:
    "Permintaan tidak dapat diproses. Muat ulang halaman lalu coba lagi.",
  competition_tags_invalid_value: "Pilih tag dari daftar yang tersedia.",
};

const SAVE_FALLBACK = "Gagal menyimpan tag. Coba lagi.";

/** Replaces the competition's tags. A refusal or a failed request comes back as the error text. */
export const saveCompetitionTags = async (
  expectedUserId: string,
  competitionId: string,
  tags: string[],
): Promise<CompetitionPartSaveResult> => {
  try {
    const response = await sessionFetch(
      expectedUserId,
      `/api/v1/competitions/${competitionId}/tags`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      },
    );
    if (!response.ok) {
      const code = await readErrorCode(response);
      return { ok: false, errorMessage: errorMessageFor(code, SAVE_ERROR_COPY, SAVE_FALLBACK) };
    }
    return { ok: true };
  } catch {
    return { ok: false, errorMessage: "Gagal menyimpan tag karena gangguan koneksi." };
  }
};

const TagsSection = ({ children }: { children: ReactNode }) => (
  <section className="content-section surface-card card-padding stack-md">
    <div className="stack-xs">
      <h2 className="section-title">Tag</h2>
      <p className="form-help">Pilih label tambahan yang menggambarkan kompetisi ini.</p>
    </div>
    {children}
  </section>
);

const TagCheckboxes = ({
  isSelected,
  onToggle,
}: {
  isSelected: (tag: string) => boolean;
  onToggle: (tag: string) => void;
}) => (
  <div className="cluster">
    {ALLOWED_COMPETITION_TAGS.map((tag) => (
      <CheckboxField key={tag} checked={isSelected(tag)} onChange={() => onToggle(tag)}>
        {tag}
      </CheckboxField>
    ))}
  </div>
);

type StoredTagsProps = { competitionId: string; expectedUserId: string };

// A competition that does not exist yet has nothing to load or save, so its creator holds the tags.
type ControlledTagsProps = {
  competitionId?: undefined;
  value: string[];
  onChange: (tags: string[]) => void;
};

export const CompetitionTagsEditor = (props: StoredTagsProps | ControlledTagsProps) => {
  if (props.competitionId === undefined) {
    return <ControlledTagsEditor value={props.value} onChange={props.onChange} />;
  }
  return (
    <StoredTagsEditor competitionId={props.competitionId} expectedUserId={props.expectedUserId} />
  );
};

const ControlledTagsEditor = ({ value, onChange }: Omit<ControlledTagsProps, "competitionId">) => {
  const toggle = (tag: string) => {
    const next = value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag];
    onChange(next);
  };

  return (
    <TagsSection>
      <TagCheckboxes isSelected={(tag) => value.includes(tag)} onToggle={toggle} />
    </TagsSection>
  );
};

const sameTags = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((tag) => b.has(tag));

const StoredTagsEditor = ({ competitionId, expectedUserId }: StoredTagsProps) => {
  const { addToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savedTags, setSavedTags] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);

  const loadTags = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/competitions/${competitionId}/tags`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        addToast({ type: "error", message: "Gagal memuat tag." });
        return;
      }
      const { tags } = (await response.json()) as { tags: string[] };
      setSelected(new Set(tags));
      setSavedTags(new Set(tags));
      setHasLoaded(true);
    } catch {
      addToast({ type: "error", message: "Gagal memuat tag." });
    } finally {
      setIsLoading(false);
    }
  }, [competitionId, addToast]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const toggle = (tag: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const isDirty = !sameTags(selected, savedTags);

  const saveTags = async (): Promise<CompetitionPartSaveResult> => {
    const sentTags = new Set(selected);
    const result = await saveCompetitionTags(expectedUserId, competitionId, [...sentTags]);
    if (result.ok) setSavedTags(sentTags);
    return result;
  };

  useCompetitionEditorPart("tags", isDirty, saveTags);

  return (
    <TagsSection>
      {isLoading ? (
        <p className="muted-copy">Memuat tag…</p>
      ) : !hasLoaded ? (
        <Feedback tone="error">{describePartLoadFailure("tags")}</Feedback>
      ) : (
        <div className="stack-md">
          <TagCheckboxes isSelected={(tag) => selected.has(tag)} onToggle={toggle} />
        </div>
      )}
    </TagsSection>
  );
};
