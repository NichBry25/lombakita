"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  FormActionBar,
  FormInput,
  FormLabelText,
  FormTextarea,
  IconButton,
  PageHeader,
  SelectField,
  usePageTransition,
} from "@/components/ui";
import { StepIndicator } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  COMPETITION_STEP_COUNT,
  COMPETITION_STEP_TITLES,
  getCompetitionStepHref,
} from "@/components/institution/competition-steps";
import {
  CompetitionTagsEditor,
  saveCompetitionTags,
} from "@/components/institution/competition-tags-editor";

import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";

const COMPETITION_CREATE_ERROR_MESSAGES: Record<string, string> = {
  recruiter_role_not_verified:
    "Verifikasi akun penyelenggara Anda terlebih dahulu untuk membuat kompetisi.",
  recruiter_tier_insufficient: "Selesaikan verifikasi penyelenggara untuk dapat membuat kompetisi.",
  competition_invalid_value: "Periksa judul, slug, dan kategori lalu coba lagi.",
  competition_slug_taken:
    "Slug ini sudah dipakai kompetisi lain di institusi ini. Pilih slug lain.",
  institution_suspended: "Institusi ini sedang ditangguhkan oleh tim Lombakita.",
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { code?: string } };
    const code = payload.error?.code;
    const message = code ? COMPETITION_CREATE_ERROR_MESSAGES[code] : undefined;
    return message ?? "Permintaan gagal diproses.";
  } catch {
    return "Permintaan gagal diproses.";
  }
};

type CreatedCompetition = { id: string; slug: string };

// "next" opens step 2 of the new draft; "exit" returns to the competition list.
type CreateAction = "next" | "exit";

export const InstitutionCompetitionCreateShell = ({
  institutionSlug,
  expectedUserId,
}: {
  institutionSlug: string;
  // Rule 16: the rendered-for user id, sent as `X-Expected-User-Id` on the tags save.
  expectedUserId: string;
}) => {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<CreateAction | null>(null);
  const { addToast } = useToast();
  const { runAndNavigate } = usePageTransition();
  const router = useRouter();
  const backHref = `/institution/${institutionSlug}/competitions`;

  // Resolves to the new draft, or to null when the create failed and its toast is shown.
  const createDraft = async (): Promise<CreatedCompetition | null> => {
    const body: Record<string, unknown> = {
      institutionSlug,
      title: title.trim(),
      category,
      description,
    };
    if (slug.trim().length > 0) body.slug = slug.trim();

    let response: Response;
    try {
      response = await fetch("/api/v1/competitions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
    } catch {
      addToast({ type: "error", message: "Gagal mengirim permintaan karena gangguan koneksi." });
      return null;
    }

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      addToast({ type: "error", message });
      return null;
    }

    const data = (await response.json()) as { competition: CreatedCompetition };
    return data.competition;
  };

  // Resolves to whether the selected tags are stored; a failure has already shown its toast.
  const saveSelectedTags = async (competitionId: string): Promise<boolean> => {
    if (tags.length === 0) return true;
    const result = await saveCompetitionTags(expectedUserId, competitionId, tags);
    if (!result.ok) {
      addToast({ type: "error", message: result.errorMessage });
      return false;
    }
    return true;
  };

  // Institution-side competition pages are slug-keyed, so the draft is opened by its slug. A draft
  // whose tags were not saved reopens at step 1, where the tags are.
  const createAndOpen = async (action: CreateAction): Promise<boolean> => {
    setPendingAction(action);
    const created = await createDraft();
    if (!created) {
      setPendingAction(null);
      return false;
    }
    const tagsSaved = await saveSelectedTags(created.id);
    const draftStep = tagsSaved ? 2 : 1;
    const destination =
      action === "exit" && tagsSaved
        ? backHref
        : getCompetitionStepHref(institutionSlug, created.slug, draftStep);
    router.replace(destination);
    return true;
  };

  const onCreate = (action: CreateAction) => {
    if (category === "") {
      addToast({ type: "error", message: "Pilih kategori kompetisi." });
      return;
    }
    void runAndNavigate(() => createAndOpen(action), { message: "Membuat kompetisi…" });
  };

  return (
    <main className="page-shell app-page competition-form-page">
      <PageHeader title="Buat kompetisi" />
      <StepIndicator
        current={1}
        total={COMPETITION_STEP_COUNT}
        label={COMPETITION_STEP_TITLES[1]}
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCreate("next");
        }}
        className="content-section stack-md"
      >
        <label className="form-field">
          <FormLabelText required>Judul</FormLabelText>
          <FormInput
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={5}
            maxLength={200}
          />
          <span className="form-help">5 sampai 200 karakter.</span>
        </label>

        <div className="form-field">
          <FormLabelText id="create-category-label" required>
            Kategori
          </FormLabelText>
          <SelectField
            label="Kategori"
            id="create-category-label"
            value={category}
            placeholder="Pilih"
            required
            options={[...COMPETITION_CATEGORY_OPTIONS]}
            onChange={setCategory}
          />
        </div>

        <label className="form-field">
          <FormLabelText optional>Deskripsi</FormLabelText>
          <FormTextarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={10000}
          />
        </label>

        <label className="form-field">
          <FormLabelText optional>Slug</FormLabelText>
          <FormInput type="text" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <span className="form-help">Gunakan huruf kecil, angka, dan tanda hubung.</span>
        </label>
      </form>

      <CompetitionTagsEditor value={tags} onChange={setTags} />

      <FormActionBar>
        <IconButton
          variant="plain"
          size="back"
          icon="arrow-left"
          label="Kembali ke daftar kompetisi"
          onClick={() => router.push(backHref)}
        />
        <div className="form-action-bar-end">
          <Button
            variant="outline"
            type="button"
            onClick={() => onCreate("exit")}
            loading={pendingAction === "exit"}
            disabled={pendingAction !== null}
          >
            Simpan dan keluar
          </Button>
          <Button
            type="button"
            onClick={() => onCreate("next")}
            loading={pendingAction === "next"}
            disabled={pendingAction !== null}
          >
            Lanjut
          </Button>
        </div>
      </FormActionBar>
    </main>
  );
};
