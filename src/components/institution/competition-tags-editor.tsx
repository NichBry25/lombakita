"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, CheckboxField } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { ALLOWED_COMPETITION_TAGS } from "@/lib/competitions/tags";
import {
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

export const CompetitionTagsEditor = ({
  competitionId,
  expectedUserId,
}: {
  competitionId: string;
  expectedUserId: string;
}) => {
  const { addToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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

  const saveTags = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const response = await sessionFetch(
        expectedUserId,
        `/api/v1/competitions/${competitionId}/tags`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: [...selected] }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        addToast({
          type: "error",
          message:
            body?.error?.code === SESSION_MISMATCH_CODE
              ? SESSION_MISMATCH_MESSAGE
              : (body?.error?.message ?? "Gagal menyimpan tag. Coba lagi."),
        });
        return;
      }
      addToast({ type: "success", message: "Tag berhasil disimpan." });
    } catch {
      addToast({ type: "error", message: "Gagal menyimpan tag karena gangguan koneksi." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="content-section stack-md">
      <div className="stack-xs">
        <h2 className="section-title">Tag</h2>
        <p className="form-help">Pilih label tambahan yang menggambarkan kompetisi ini.</p>
      </div>

      {isLoading ? (
        <p className="muted-copy">Memuat tag…</p>
      ) : (
        <div className="stack-md">
          <div className="cluster">
            {ALLOWED_COMPETITION_TAGS.map((tag) => (
              <CheckboxField key={tag} checked={selected.has(tag)} onChange={() => toggle(tag)}>
                {tag}
              </CheckboxField>
            ))}
          </div>
          <Button type="button" onClick={saveTags} loading={isSaving}>
            Simpan
          </Button>
        </div>
      )}
    </section>
  );
};
