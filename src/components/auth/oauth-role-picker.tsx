"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

// Step 6.5d — minimal-proof OAuth role picker. Reached after a brand-new Google user is routed to
// /auth/login?oauth=<carrier> (Step 6.5d.1 merged the role picker onto the single login page). The
// carrier is the server's HMAC-signed Google identity; this
// component never parses it, it only forwards it (plus the declared role) to the oauth-finalize
// credentials provider, which verifies the carrier, creates the account, and signs the user in.
type OAuthRolePickerProps = {
  carrier: string;
  email: string;
};

const mapFinalizeError = (error: string | null | undefined): string => {
  const normalized = error?.toUpperCase() ?? "";
  if (normalized.includes("INVALID_CARRIER")) {
    return "Sesi Google sudah kedaluwarsa atau tidak valid. Silakan masuk dengan Google lagi.";
  }
  if (normalized.includes("ACCOUNT_CONFLICT")) {
    return "Akun untuk email ini sudah ada. Coba masuk dengan metode yang sudah terdaftar.";
  }
  if (normalized.includes("INVALID_ROLE")) {
    return "Peran tidak valid. Pilih Kandidat atau Recruiter.";
  }
  return "Pendaftaran dengan Google gagal. Silakan coba lagi.";
};

export const OAuthRolePicker = ({ carrier, email }: OAuthRolePickerProps) => {
  const [isSubmitting, setIsSubmitting] = useState<"candidate" | "recruiter" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const finalize = async (role: "candidate" | "recruiter") => {
    setIsSubmitting(role);
    setErrorMessage(null);

    try {
      const result = await signIn(OAUTH_FINALIZE_PROVIDER, {
        carrier,
        role,
        callbackUrl: "/",
        redirect: false,
      });

      if (result?.ok && result.url) {
        window.location.assign(result.url);
        return;
      }

      setErrorMessage(mapFinalizeError(result?.error));
    } catch {
      setErrorMessage(
        "Pendaftaran dengan Google gagal karena gangguan koneksi atau server. Coba lagi.",
      );
    } finally {
      setIsSubmitting(null);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-12">
      <section className="rounded-2xl border border-zinc-200 bg-white p-5 md:p-6">
        <h2 className="text-xl font-semibold text-zinc-900">Selesaikan pendaftaran dengan Google</h2>
        <p className="mt-2 text-sm text-zinc-600">
          Anda masuk sebagai <span className="font-medium text-zinc-900">{email}</span>. Pilih peran
          untuk menyelesaikan pembuatan akun. Akun baru hanya dibuat setelah Anda memilih peran.
        </p>

        <div className="mt-6 space-y-3">
          <button
            type="button"
            disabled={isSubmitting !== null}
            onClick={() => {
              void finalize("candidate");
            }}
            className="block w-full rounded-xl border border-zinc-200 p-4 text-left text-sm font-medium text-zinc-900 hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting === "candidate" ? "Membuat akun..." : "Daftar sebagai Kandidat"}
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">
              Mahasiswa atau lulusan yang mencari kompetisi, beasiswa, dan peluang lain.
            </span>
          </button>
          <button
            type="button"
            disabled={isSubmitting !== null}
            onClick={() => {
              void finalize("recruiter");
            }}
            className="block w-full rounded-xl border border-zinc-200 p-4 text-left text-sm font-medium text-zinc-900 hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting === "recruiter" ? "Membuat akun..." : "Daftar sebagai Recruiter"}
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">
              Perwakilan institusi yang ingin menerbitkan dan mengelola peluang.
            </span>
          </button>
        </div>

        {errorMessage ? <p className="mt-4 text-xs text-rose-700">{errorMessage}</p> : null}
      </section>
    </main>
  );
};

// The oauth-finalize provider id must match OAUTH_FINALIZE_PROVIDER_ID in oauth-account.ts. Kept as
// a local literal because this is a client component and may not import server-only modules.
const OAUTH_FINALIZE_PROVIDER = "oauth-finalize";
