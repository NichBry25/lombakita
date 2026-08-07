"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "next-auth/react";
import { Button, usePageTransition } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { describeMfaLockout, readMfaErrorPayload } from "@/lib/mfa/mfa-error-response";
import { sessionFetch } from "@/lib/session/session-fetch";

type MfaChallengeFormProps = {
  callbackUrl: string;
};

type Mode = "totp" | "recovery";

export function MfaChallengeForm({ callbackUrl }: MfaChallengeFormProps) {
  const { data: sessionData, update } = useSession();
  const { addToast, removeToast } = useToast();
  const { begin } = usePageTransition();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const lastToastIdRef = useRef<string | null>(null);

  const expectedUserId = sessionData?.user?.id;

  // One toast at a time. Five wrong codes previously stacked five identical toasts over the submit
  // button and the recovery link — the controls the operator needed next — and repeating the same
  // sentence conveys nothing the first one did not.
  const showError = (message: string) => {
    if (lastToastIdRef.current) {
      removeToast(lastToastIdRef.current);
    }
    lastToastIdRef.current = addToast({ type: "error", message });
  };

  // The lock clears itself at the moment the server would start accepting codes again, so the notice
  // and the disabled button never outlive the lock they describe.
  useEffect(() => {
    if (lockoutSeconds === null) return;
    const handle = setTimeout(() => setLockoutSeconds(null), lockoutSeconds * 1000);
    return () => clearTimeout(handle);
  }, [lockoutSeconds]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !expectedUserId) return;

    const trimmed = code.trim();
    if (mode === "totp" && !/^\d{6}$/.test(trimmed)) {
      showError("Masukkan kode 6 digit dari aplikasi autentikator Anda.");
      return;
    }
    if (mode === "recovery" && trimmed.length === 0) {
      showError("Masukkan salah satu kode pemulihan Anda.");
      return;
    }

    setBusy(true);
    try {
      const endpoint = mode === "totp" ? "/api/v1/auth/mfa/challenge" : "/api/v1/auth/mfa/recovery";
      const response = await sessionFetch(expectedUserId, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });

      if (!response.ok) {
        const payload = await readMfaErrorPayload(response);

        // A lockout is page state, not a transient one: it holds for fifteen minutes and names the
        // only way out, so it renders as a panel that stays put. A toast that vanishes in five
        // seconds cannot carry either fact.
        if (payload.retryAfterSeconds !== null) {
          if (lastToastIdRef.current) {
            removeToast(lastToastIdRef.current);
            lastToastIdRef.current = null;
          }
          setLockoutSeconds(payload.retryAfterSeconds);
        } else {
          showError(payload.message ?? "Kode tidak valid. Coba lagi.");
        }

        setBusy(false);
        return;
      }

      begin(mode === "totp" ? "Memverifikasi…" : "Mengatur ulang verifikasi dua langkah…");

      if (mode === "totp") {
        const payload = (await response.json()) as { elevationGrantId: string };
        await update({ mfaElevationGrant: payload.elevationGrantId });
        window.location.assign(callbackUrl);
      } else {
        // Recovery redemption deletes the factor and stamps mfa_invalidated_at server-side — the
        // account is now back in `enrolment_required`. A bare update() forces the session callback
        // to re-run its live DB read, and /auth/mfa/enroll's own guard sends the account to the
        // right place from there; this route hands out no elevation grant to redirect around it.
        await update();
        window.location.assign(`/auth/mfa/enroll?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      }
    } catch {
      showError("Gangguan koneksi. Periksa jaringan Anda lalu coba lagi.");
      setBusy(false);
    }
  };

  const locked = lockoutSeconds !== null;

  return (
    <form onSubmit={onSubmit} className="auth-form stack-md">
      <header className="auth-entry-header">
        <p className="eyebrow">Verifikasi dua langkah</p>
        {/* The heading follows the mode. It sat on the page as a fixed "Masukkan kode verifikasi",
            so switching to recovery left the page telling the operator to do the one thing the form
            in front of them no longer accepted. */}
        <h1>{mode === "totp" ? "Masukkan kode verifikasi" : "Gunakan kode pemulihan"}</h1>
      </header>

      {locked ? (
        <div className="feedback" data-tone="error" role="alert">
          <p>{describeMfaLockout(lockoutSeconds)}</p>
        </div>
      ) : null}

      {mode === "totp" ? (
        <div className="form-field">
          <label className="form-label form-label-required" htmlFor="mfa-challenge-code">
            Kode verifikasi
          </label>
          <input
            id="mfa-challenge-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            className="form-input"
            placeholder="123456"
          />
        </div>
      ) : (
        <div className="form-field">
          <label className="form-label form-label-required" htmlFor="mfa-challenge-recovery-code">
            Kode pemulihan
          </label>
          <input
            id="mfa-challenge-recovery-code"
            type="text"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="form-input"
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
          />
          <p className="form-hint">
            Menggunakan kode pemulihan akan menghapus verifikasi dua langkah Anda saat ini dan
            meminta Anda mengaktifkannya kembali.
          </p>
        </div>
      )}

      <Button type="submit" loading={busy} disabled={locked} data-testid="mfa-challenge-submit">
        {mode === "totp" ? "Verifikasi" : "Gunakan kode pemulihan"}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setMode(mode === "totp" ? "recovery" : "totp");
          setCode("");
        }}
      >
        {mode === "totp" ? "Tidak bisa mengakses aplikasi autentikator?" : "Kembali"}
      </Button>
    </form>
  );
}
