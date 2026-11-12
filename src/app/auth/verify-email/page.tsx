import { ButtonLink } from "@/components/ui";
import { redirect } from "next/navigation";
import { AuthPageFrame } from "@/components/auth/auth-page-frame";
import { CredentialsAuthError, verifyRegistrationEmailToken } from "@/server/auth/credentials-auth";
import { reportUnexpectedError } from "@/server/observability/report-unexpected-error";
import { sameSitePathOr } from "@/lib/session/return-path";

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
        description:
          "Tautan verifikasi tidak valid atau sudah dipakai. Kembali ke halaman login untuk kirim ulang verifikasi.",
      };
    }

    reportUnexpectedError("email verification", error);
    return {
      status: "error",
      title: "Verifikasi gagal",
      description: "Terjadi kesalahan tak terduga saat memverifikasi akun.",
    };
  }
};

export default async function VerifyEmailPage(props: {
  searchParams?: Promise<{ token?: string; callbackUrl?: string }>;
}) {
  const searchParams = await props.searchParams;
  const state = await resolveState(searchParams?.token);
  const returnPath = sameSitePathOr(searchParams?.callbackUrl, "");
  const signInHref = returnPath
    ? `/auth/login?callbackUrl=${encodeURIComponent(returnPath)}`
    : "/auth/login";

  if (state.status === "success" && state.email) {
    const signInParams = new URLSearchParams({ verified: "1", email: state.email });
    if (returnPath) {
      signInParams.set("callbackUrl", returnPath);
    }
    redirect(`/auth/login?${signInParams.toString()}`);
  }

  return (
    <AuthPageFrame
      title="Tautan verifikasi hanya berlaku sekali"
      description="Jika tautan sudah tidak berlaku, minta tautan baru dari halaman masuk."
    >
      <div className="auth-state stack-md">
        <span className="auth-state-icon" data-tone="error" aria-hidden="true">
          !
        </span>
        <div className="stack-xs">
          <h1>{state.title}</h1>
          <p>{state.description}</p>
        </div>
        <ButtonLink variant="primary" size="md" href={signInHref}>
          Kembali ke halaman masuk
        </ButtonLink>
      </div>
    </AuthPageFrame>
  );
}
