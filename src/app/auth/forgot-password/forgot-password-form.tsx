"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, ButtonLink, Icon } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { COMPANY } from "@/config/company";

const RESEND_COOLDOWN_SECONDS = 60;

const MESSAGES = {
  rateLimited: "Terlalu banyak percobaan. Coba lagi beberapa saat.",
  invalidEmail: "Format email tidak valid. Gunakan format seperti nama@kampus.ac.id.",
  connection: "Terjadi gangguan koneksi. Coba lagi beberapa saat.",
  generic: "Terjadi kesalahan. Coba lagi beberapa saat.",
} as const;

type ForgotPasswordFormProps = {
  initialEmail: string;
};

export function ForgotPasswordForm({ initialEmail }: ForgotPasswordFormProps) {
  const { addToast } = useToast();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const secondsUntilResend =
    lastSentAt === null
      ? 0
      : Math.max(0, Math.ceil((lastSentAt + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000));

  useEffect(() => {
    if (secondsUntilResend <= 0) return;
    const handle = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(handle);
  }, [secondsUntilResend, now]);

  const requestLink = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);

    try {
      const response = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (response.status === 429) {
        addToast({ type: "error", message: MESSAGES.rateLimited });
      } else if (response.status === 400) {
        addToast({ type: "error", message: MESSAGES.invalidEmail });
      } else if (!response.ok) {
        addToast({ type: "error", message: MESSAGES.generic });
      } else {
        const sentAt = Date.now();
        setNow(sentAt);
        setLastSentAt(sentAt);
      }
    } catch {
      addToast({ type: "error", message: MESSAGES.connection });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void requestLink();
  };

  if (lastSentAt !== null) {
    return (
      <div className="auth-state stack-md">
        <span className="auth-state-icon" aria-hidden="true">
          <Icon name="check" size="lg" />
        </span>
        <div className="stack-xs">
          <h1>Cek email Anda</h1>
          <p>
            Jika email itu terdaftar, kami sudah mengirim tautan untuk mengatur ulang password.
            Tautan berlaku 30 menit. Belum ada email dalam beberapa menit? Periksa folder spam, lalu
            minta lagi setelah 60 detik atau hubungi{" "}
            <a href={`mailto:${COMPANY.supportEmail}`}>{COMPANY.supportEmail}</a>.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          loading={busy}
          disabled={secondsUntilResend > 0}
          onClick={() => void requestLink()}
        >
          {secondsUntilResend > 0 ? `Kirim ulang dalam ${secondsUntilResend} detik` : "Kirim ulang"}
        </Button>
        <ButtonLink href="/auth/login" variant="ghost">
          Kembali ke halaman masuk
        </ButtonLink>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="auth-form stack-md">
      <header className="auth-entry-header">
        <h1>Atur ulang password</h1>
      </header>

      <div className="form-field">
        <label className="form-label form-label-required" htmlFor="forgot-password-email">
          Email
        </label>
        <input
          id="forgot-password-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="form-input"
        />
      </div>

      <Button type="submit" loading={busy}>
        Kirim tautan atur ulang
      </Button>
    </form>
  );
}
