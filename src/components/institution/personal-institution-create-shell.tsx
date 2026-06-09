"use client";

import Link from "next/link";
import { useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
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
  const { addToast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInstitution | null>(null);

  // No name or slug input: a personal institution's name derives from your username and its slug is
  // derived through the shared slug path. Creation is a single submit.
  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsCreating(true);

    const response = await sessionFetch(expectedUserId, "/api/v1/institutions/personal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      addToast({ type: "error", message: await extractErrorMessage(response) });
      setIsCreating(false);
      return;
    }

    const data = (await response.json()) as PersonalInstitutionResponse;
    setCreated({
      displayName: data.institution.displayName,
      slug: data.institution.slug,
    });
    addToast({ type: "success", message: "Institusi personal berhasil dibuat." });
    setIsCreating(false);
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-14">
      <header>
        <h1 className="text-2xl font-semibold text-gleam">Buat Institusi Personal</h1>
        <p className="text-sm">
          Institusi personal bersifat ringan dan satu anggota: maksimal 2 kompetisi terbit, hanya
          mode individu, tanpa penempatan unggulan, dan tanpa undangan staf. Namanya mengikuti
          username Anda — tidak ada nama yang perlu diisi.
        </p>
      </header>

      <section className="glass-card p-6 space-y-4">
        {created ? (
          <div className="space-y-3">
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Institusi personal berhasil dibuat.
            </p>
            <p className="text-sm">
              Nama: <strong>{created.displayName}</strong>
            </p>
            <p className="text-sm">
              Slug: <strong>{created.slug}</strong>
            </p>
            <Link
              className="action-chip inline-block"
              href={`/institution/${created.slug}/settings`}
              prefetch={false}
            >
              Buka Institusi
            </Link>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            <button className="primary-button" type="submit" disabled={isCreating}>
              {isCreating ? "Menyimpan..." : "Buat Institusi Personal"}
            </button>
          </form>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SignOutButton />
        <Link className="text-sm underline" href="/" prefetch={false}>
          Kembali ke beranda
        </Link>
      </div>
    </main>
  );
};
