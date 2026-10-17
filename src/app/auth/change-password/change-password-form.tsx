"use client";

import { useEffect, useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";
import { Button, usePageTransition } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { NewPasswordFields, validateNewPassword } from "@/components/auth/new-password-fields";
import {
  readErrorCode,
  resolveSessionMismatchMessage,
  sessionFetch,
} from "@/lib/session/session-fetch";

const MESSAGES = {
  unavailable: "Layanan sementara tidak tersedia. Coba lagi beberapa saat.",
  wrongCurrent: "Password saat ini salah.",
  invalidPassword: "Password harus 8 sampai 72 karakter.",
  connection: "Terjadi gangguan koneksi. Coba lagi beberapa saat.",
  generic: "Terjadi kesalahan. Coba lagi beberapa saat.",
} as const;

// `null` seconds is a limit whose wait the server did not report: the panel names no number, the
// submit stays enabled, and the next submit attempt clears the panel.
type Lockout = { seconds: number | null };

const describeLockout = (lockout: Lockout): string =>
  lockout.seconds === null
    ? "Terlalu banyak password saat ini yang salah. Coba lagi nanti."
    : `Terlalu banyak password saat ini yang salah. Coba lagi dalam ${Math.ceil(lockout.seconds / 60)} menit.`;

const parseRetryAfterSeconds = (header: string | null): number | null => {
  const seconds = header === null ? Number.NaN : Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

const messageForRefusal = (code: string | null): string => {
  if (code === "invalid_current_password") return MESSAGES.wrongCurrent;
  if (code === "invalid_password") return MESSAGES.invalidPassword;
  return resolveSessionMismatchMessage(code, MESSAGES.generic);
};

type ChangePasswordFormProps = {
  expectedUserId: string;
};

export function ChangePasswordForm({ expectedUserId }: ChangePasswordFormProps) {
  const { addToast } = useToast();
  const { begin } = usePageTransition();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockout, setLockout] = useState<Lockout | null>(null);

  const lockoutSeconds = lockout?.seconds ?? null;

  // The panel and the disabled submit end at the moment the server would accept guesses again.
  useEffect(() => {
    if (lockoutSeconds === null) return;
    const handle = setTimeout(() => setLockout(null), lockoutSeconds * 1000);
    return () => clearTimeout(handle);
  }, [lockoutSeconds]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    setLockout(null);

    const problem = validateNewPassword(password, confirmation);
    if (problem) {
      addToast({ type: "error", message: problem });
      return;
    }

    setBusy(true);
    try {
      const response = await sessionFetch(expectedUserId, "/api/v1/auth/password/change", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword: password }),
      });

      if (response.ok) {
        begin("Mengeluarkan semua perangkat…");
        await signOut({ callbackUrl: "/auth/login?passwordChanged=1" });
        return;
      }

      if (response.status === 429) {
        setLockout({ seconds: parseRetryAfterSeconds(response.headers.get("Retry-After")) });
      } else if (response.status === 503) {
        addToast({ type: "error", message: MESSAGES.unavailable });
      } else {
        const code = await readErrorCode(response);
        addToast({ type: "error", message: messageForRefusal(code) });
      }
      setBusy(false);
    } catch {
      addToast({ type: "error", message: MESSAGES.connection });
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="auth-form stack-md">
      <header className="auth-entry-header">
        <h1>Ubah password</h1>
      </header>

      {lockout ? (
        <div className="feedback" data-tone="error" role="alert">
          <p>{describeLockout(lockout)}</p>
        </div>
      ) : null}

      <div className="form-field">
        <label className="form-label form-label-required" htmlFor="change-current-password">
          Password saat ini
        </label>
        <input
          id="change-current-password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className="form-input"
        />
      </div>

      <NewPasswordFields
        idPrefix="change"
        password={password}
        confirmation={confirmation}
        onPasswordChange={setPassword}
        onConfirmationChange={setConfirmation}
      />

      <Button type="submit" loading={busy} disabled={lockoutSeconds !== null}>
        Ubah password
      </Button>
    </form>
  );
}
