"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

type SignupFormProps = {
  signupRole: "candidate" | "recruiter";
  verificationEnabled: boolean;
};

type ApiError = {
  code?: string;
  message?: string;
};

const parseApiError = async (response: Response): Promise<ApiError | null> => {
  try {
    const payload = (await response.json()) as { error?: ApiError };
    return payload.error ?? null;
  } catch {
    return null;
  }
};

// Minimal proof only — no design polish. Inline styles only per CLAUDE.md UI level rule.
export const SignupForm = ({ signupRole, verificationEnabled }: SignupFormProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!verificationEnabled) {
      setErrorMessage(
        "Pendaftaran tidak tersedia karena konfigurasi email verifikasi (Resend) belum lengkap.",
      );
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/v1/auth/register?as=${encodeURIComponent(signupRole)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (!response.ok) {
        const apiError = await parseApiError(response);
        setErrorMessage(
          apiError?.message ?? `Pendaftaran gagal (kode: ${apiError?.code ?? "tidak diketahui"}).`,
        );
        return;
      }

      const payload = (await response.json()) as {
        registration: { email: string; verificationRequired: boolean; alreadyVerified: boolean };
      };

      if (payload.registration.alreadyVerified) {
        setStatusMessage(
          "Email ini sudah pernah diverifikasi. Password telah diperbarui. Silakan login.",
        );
      } else {
        setStatusMessage(
          "Pendaftaran berhasil. Kami telah mengirim email verifikasi. Buka inbox Anda untuk aktivasi.",
        );
      }
      setPassword("");
    } catch {
      setErrorMessage(
        "Pendaftaran gagal karena gangguan koneksi atau server. Coba kembali beberapa saat lagi.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const heading =
    signupRole === "candidate" ? "Daftar sebagai Kandidat" : "Daftar sebagai Recruiter";
  const description =
    signupRole === "candidate"
      ? "Akun ini akan terverifikasi sebagai kandidat. Mode recruiter masih belum terverifikasi."
      : "Akun ini akan terverifikasi sebagai recruiter. Mode kandidat masih belum terverifikasi.";

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>{heading}</h1>
      <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#52525b" }}>{description}</p>

      <form
        onSubmit={onSubmit}
        style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label htmlFor="signup-name" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
          Nama lengkap
        </label>
        <input
          id="signup-name"
          name="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ padding: "0.5rem", border: "1px solid #d4d4d8", borderRadius: 6 }}
        />

        <label htmlFor="signup-email" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
          Email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ padding: "0.5rem", border: "1px solid #d4d4d8", borderRadius: 6 }}
        />

        <label htmlFor="signup-password" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
          Password
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: "0.5rem", border: "1px solid #d4d4d8", borderRadius: 6 }}
        />

        <button
          type="submit"
          disabled={isSubmitting || !verificationEnabled}
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem 1rem",
            background: "#18181b",
            color: "white",
            borderRadius: 6,
            cursor: isSubmitting ? "not-allowed" : "pointer",
            opacity: isSubmitting ? 0.5 : 1,
          }}
        >
          {isSubmitting ? "Memproses..." : "Daftar"}
        </button>
      </form>

      {statusMessage ? (
        <p role="status" style={{ marginTop: "0.75rem", fontSize: "0.875rem", color: "#047857" }}>
          {statusMessage}
        </p>
      ) : null}
      {errorMessage ? (
        <p role="alert" style={{ marginTop: "0.75rem", fontSize: "0.875rem", color: "#b91c1c" }}>
          {errorMessage}
        </p>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#71717a" }}>
        <Link href="/auth/register" style={{ textDecoration: "underline" }}>
          ← Kembali ke pilihan peran
        </Link>
      </p>
    </div>
  );
};
