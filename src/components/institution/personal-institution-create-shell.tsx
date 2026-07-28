"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  FormActionBar,
  Icon,
  IconButton,
  PageHeader,
  usePageTransition,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  readErrorCode,
  SESSION_MISMATCH_CODE,
  SESSION_MISMATCH_MESSAGE,
  sessionFetch,
} from "@/lib/session/session-fetch";

type PersonalInstitutionResponse = {
  institution: {
    institutionId: string;
    displayName: string;
    slug: string;
    status: "active" | "inactive" | "suspended";
    institutionType: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

type CreatedInstitution = {
  displayName: string;
  slug: string;
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  if ((await readErrorCode(response.clone())) === SESSION_MISMATCH_CODE) {
    return SESSION_MISMATCH_MESSAGE;
  }
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message ?? "Permintaan institusi personal gagal diproses.";
  } catch {
    return "Permintaan institusi personal gagal diproses.";
  }
};

export const PersonalInstitutionCreateShell = ({ expectedUserId }: { expectedUserId: string }) => {
  const router = useRouter();
  const { addToast } = useToast();
  const { runAndNavigate } = usePageTransition();
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInstitution | null>(null);

  // No name or slug input: a personal institution's name derives from your username and its slug is
  // derived through the shared slug path. Creation is a single action from the sticky action bar.
  const onSubmit = () =>
    runAndNavigate(createInstitution, { message: "Membuat institusi personal…" });

  // Returns whether a navigation was started, so a rejected create drops the blocking screen
  // instead of leaving the user staring at it.
  const createInstitution = async (): Promise<boolean> => {
    setIsCreating(true);

    const response = await sessionFetch(expectedUserId, "/api/v1/institutions/personal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      addToast({ type: "error", message: await extractErrorMessage(response) });
      setIsCreating(false);
      return false;
    }

    const data = (await response.json()) as PersonalInstitutionResponse;
    setCreated({
      displayName: data.institution.displayName,
      slug: data.institution.slug,
    });
    addToast({ type: "success", message: "Institusi personal berhasil dibuat." });
    setIsCreating(false);
    router.replace(`/institution/${data.institution.slug}`);
    return true;
  };

  return (
    <main className="page-shell app-page personal-institution-page">
      <PageHeader
        title="Buat institusi personal"
        description="Untuk menyelenggarakan kompetisi sendiri. Nama institusi mengikuti username Anda."
      />

      <section className="content-section personal-institution-card">
        <div className="personal-institution-intro">
          <span className="personal-institution-icon" aria-hidden="true">
            <Icon name="building" size="lg" />
          </span>
          <div className="stack-xs">
            <h2>Ruang kerja satu anggota</h2>
            <p>
              Maksimal 2 kompetisi terbit, hanya mode individu, tanpa penempatan unggulan, dan tanpa
              undangan staf. Tidak ada nama yang perlu diisi.
            </p>
          </div>
        </div>

        {created ? (
          <div className="personal-institution-created">
            <dl className="profile-detail-list">
              <div>
                <dt>Nama</dt>
                <dd>{created.displayName}</dd>
              </div>
              <div>
                <dt>Slug</dt>
                <dd className="data-text">{created.slug}</dd>
              </div>
            </dl>
            <ButtonLink
              href={`/institution/${created.slug}/settings`}
              prefetch={false}
              variant="primary"
            >
              Buka institusi
            </ButtonLink>
          </div>
        ) : null}
      </section>

      <FormActionBar>
        <IconButton icon="arrow-left" label="Kembali ke beranda" onClick={() => router.push("/")} />
        {!created ? (
          <div className="form-action-bar-end">
            <Button type="button" onClick={onSubmit} loading={isCreating}>
              Buat institusi personal
            </Button>
          </div>
        ) : null}
      </FormActionBar>
    </main>
  );
};
