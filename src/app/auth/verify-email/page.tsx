import Link from "next/link";
import { redirect } from "next/navigation";
import { CredentialsAuthError, verifyRegistrationEmailToken } from "@/server/auth/credentials-auth";

type VerifyEmailPageState =
  | { status: "success"; title: string; description: string; email: string }
  | { status: "error"; title: string; description: string; email?: string };

const resolveState = async (token: string | undefined): Promise<VerifyEmailPageState> => {
  if (!token) {
    return {
      status: "error",
      title: "Tautan verifikasi tidak valid",
      description:
        "Token verifikasi tidak ditemukan. Silakan daftar ulang atau kirim ulang verifikasi.",
    };
  }

  try {
    const result = await verifyRegistrationEmailToken(token);

    if (result.status === "already_verified") {
      return {
        status: "success",
        title: "Email sudah terverifikasi",
        description: "Akun Anda sudah aktif. Silakan login dengan email dan password.",
        email: result.email,
      };
    }

    return {
      status: "success",
      title: "Email berhasil diverifikasi",
      description: "Akun Anda sudah aktif. Silakan lanjut login dengan email dan password.",
      email: result.email,
    };
  } catch (error) {
    if (error instanceof CredentialsAuthError) {
      if (error.code === "verification_token_expired") {
        return {
          status: "error",
          title: "Tautan verifikasi kedaluwarsa",
          description:
            "Tautan verifikasi sudah kedaluwarsa. Kembali ke halaman login untuk kirim ulang verifikasi.",
        };
      }

      return {
        status: "error",
        title: "Verifikasi gagal",
        description: error.message,
      };
    }

    return {
      status: "error",
      title: "Verifikasi gagal",
      description: "Terjadi kesalahan tak terduga saat memverifikasi akun.",
    };
  }
};

export default async function VerifyEmailPage(props: {
  searchParams?: Promise<{ token?: string }>;
}) {
  const searchParams = await props.searchParams;
  const state = await resolveState(searchParams?.token);
  const signInHref = "/auth/sign-in";

  if (state.status === "success" && state.email) {
    redirect(`/auth/activated?email=${encodeURIComponent(state.email)}`);
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 py-14 text-center">
      <h1 className="text-3xl font-semibold text-[var(--text-primary)]">{state.title}</h1>
      <p className="max-w-lg text-sm text-[var(--text-muted)]">{state.description}</p>

      <div className="pt-2">
        <Link className="primary-button inline-flex" href={signInHref}>
          Kembali ke login
        </Link>
      </div>
    </main>
  );
}
