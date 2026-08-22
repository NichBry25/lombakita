"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSession } from "next-auth/react";
import { Button, CheckboxField, Icon, IconButton, usePageTransition } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import {
  describeMfaLockout,
  presentMfaError,
  readMfaErrorPayload,
} from "@/lib/mfa/mfa-error-response";
import { sessionFetch } from "@/lib/session/session-fetch";

type MfaEnrollFormProps = {
  secretBase32: string;
  otpauthUri: string;
  qrDataUrl: string;
  callbackUrl: string;
};

type Stage = "code" | "recovery-codes";

export function MfaEnrollForm({
  secretBase32,
  otpauthUri,
  qrDataUrl,
  callbackUrl,
}: MfaEnrollFormProps) {
  const { data: sessionData, update } = useSession();
  const { addToast, removeToast } = useToast();
  const { begin } = usePageTransition();
  const [stage, setStage] = useState<Stage>("code");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [elevationGrantId, setElevationGrantId] = useState<string | null>(null);
  const [savedAcknowledged, setSavedAcknowledged] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const lastToastIdRef = useRef<string | null>(null);

  const expectedUserId = sessionData?.user?.id;

  // One toast at a time, so repeated failures replace the previous notice instead of stacking over
  // the very controls the operator needs next.
  // `durationMs` is threaded through rather than left to the primitive's 5000ms default: a throttle
  // notice must outlive the wait it names, and a platform-degraded notice must not expire at all.
  const showError = (message: string, durationMs?: number) => {
    if (lastToastIdRef.current) {
      removeToast(lastToastIdRef.current);
    }
    lastToastIdRef.current = addToast({
      type: "error",
      message,
      ...(durationMs === undefined ? {} : { duration: durationMs }),
    });
  };

  // Clears itself when the server would start accepting codes again, so the notice never outlives
  // the lock it describes.
  useEffect(() => {
    if (lockoutSeconds === null) return;
    const handle = setTimeout(() => setLockoutSeconds(null), lockoutSeconds * 1000);
    return () => clearTimeout(handle);
  }, [lockoutSeconds]);

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(secretBase32);
      addToast({ type: "success", message: "Kunci disalin ke clipboard." });
    } catch {
      showError("Gagal menyalin. Salin kunci secara manual.");
    }
  };

  const onSubmitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !expectedUserId) return;

    if (!/^\d{6}$/.test(code)) {
      showError("Masukkan kode 6 digit dari aplikasi autentikator Anda.");
      return;
    }

    setBusy(true);
    try {
      const response = await sessionFetch(expectedUserId, "/api/v1/auth/mfa/enroll/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });

      if (!response.ok) {
        const payload = await readMfaErrorPayload(response);
        const presentation = presentMfaError(payload);

        // A lockout holds for fifteen minutes and names the only way out, so it is page state rather
        // than a five-second toast. A throttle also carries a wait but is not a lockout, so the
        // branch is on the classified presentation rather than on `retryAfterSeconds` alone.
        if (presentation.render === "panel") {
          if (lastToastIdRef.current) {
            removeToast(lastToastIdRef.current);
            lastToastIdRef.current = null;
          }
          setLockoutSeconds(presentation.retryAfterSeconds);
        } else {
          showError(presentation.message, presentation.durationMs);
        }

        setBusy(false);
        return;
      }

      const payload = (await response.json()) as {
        recoveryCodes: string[];
        elevationGrantId: string | null;
      };
      setRecoveryCodes(payload.recoveryCodes);
      setElevationGrantId(payload.elevationGrantId);
      setStage("recovery-codes");
      setBusy(false);
    } catch {
      showError("Gangguan koneksi. Periksa jaringan Anda lalu coba lagi.");
      setBusy(false);
    }
  };

  const onCopyRecoveryCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      addToast({ type: "success", message: "Kode pemulihan disalin." });
    } catch {
      showError("Gagal menyalin. Salin kode secara manual.");
    }
  };

  const onContinue = async () => {
    if (busy) return;
    setBusy(true);
    begin("Menyelesaikan pengaktifan…");
    try {
      if (elevationGrantId) {
        await update({ mfaElevationGrant: elevationGrantId });
      } else {
        await update();
      }
    } finally {
      window.location.assign(callbackUrl);
    }
  };

  if (stage === "recovery-codes") {
    return (
      <div className="stack-md">
        {/* The QR is scanned and gone by this point, so the heading belongs to this stage rather
            than the page. A page-level "Pindai kode QR" would sit above a screen asking the
            operator to save ten recovery codes. */}
        <header className="auth-entry-header">
          <p className="eyebrow">Verifikasi dua langkah</p>
          <h1>Simpan kode pemulihan Anda</h1>
        </header>
        <div className="feedback" data-tone="warning" role="status">
          <p>
            <strong>Simpan 10 kode pemulihan ini sekarang.</strong> Setiap kode hanya bisa dipakai
            satu kali dan tidak akan ditampilkan lagi setelah Anda melanjutkan.
          </p>
        </div>
        <pre className="diagnostic-code stack-xs" aria-label="Kode pemulihan">
          {recoveryCodes.map((recoveryCode) => (
            <div key={recoveryCode}>{recoveryCode}</div>
          ))}
        </pre>
        <Button
          variant="outline"
          onClick={onCopyRecoveryCodes}
          leadingIcon={<Icon name="copy" size="sm" />}
        >
          Salin
        </Button>
        <CheckboxField
          id="mfa-recovery-ack"
          checked={savedAcknowledged}
          onChange={(event) => setSavedAcknowledged(event.target.checked)}
        >
          Saya sudah menyimpan kode pemulihan ini di tempat yang aman.
        </CheckboxField>
        <Button
          type="button"
          onClick={onContinue}
          loading={busy}
          disabled={!savedAcknowledged}
          data-testid="mfa-enroll-continue"
        >
          Lanjutkan
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmitCode} className="auth-form stack-md">
      <header className="auth-entry-header">
        <p className="eyebrow">Verifikasi dua langkah</p>
        <h1>Aktifkan 2FA</h1>
      </header>
      <p>
        Buka aplikasi autentikator (Google Authenticator, Authy, 1Password, atau sejenisnya), lalu
        daftarkan akun ini dengan salah satu cara di bawah, pilih yang mana saja, keduanya
        mendaftarkan kunci yang sama.
      </p>

      {lockoutSeconds === null ? null : (
        <div className="feedback" data-tone="error" role="alert">
          <p>{describeMfaLockout(lockoutSeconds)}</p>
        </div>
      )}

      {/* Two ways to register the same key, presented as a labelled choice rather than a primary
          path with a fallback tucked underneath it. Real headings, styled down to label size: an
          operator scanning for "the manual one" should be able to jump straight to it. */}
      <section className="mfa-method">
        <h2 className="mfa-method-title">A. Pindai kode QR</h2>
        <div className="mfa-qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrDataUrl}
            width={240}
            height={240}
            alt="Kode QR untuk mendaftarkan akun ini di aplikasi autentikator Anda. Jika tidak bisa memindai, gunakan kunci manual di bawah."
          />
        </div>
        {/* The same key the QR encodes, as a link the operating system hands to the authenticator
            app. It is the only path that needs neither a second device to scan with nor 32
            characters typed by hand, which makes it the one that matters on a phone. */}
        <a href={otpauthUri} className="mfa-method-link" data-testid="mfa-otpauth-link">
          Membuka halaman ini di ponsel? Daftarkan langsung di aplikasi autentikator
        </a>
      </section>

      <section className="mfa-method">
        <h2 className="mfa-method-title" id="mfa-secret-label">
          B. Kunci manual
        </h2>
        <div className="mfa-key">
          <code className="mfa-key-value" aria-labelledby="mfa-secret-label">
            {secretBase32}
          </code>
          <IconButton icon="copy" label="Salin kunci" onClick={copySecret} />
        </div>
      </section>

      <hr className="form-separator" />

      <div className="form-field">
        <label className="form-label form-label-required" htmlFor="mfa-enroll-code">
          Kode verifikasi
        </label>
        <input
          id="mfa-enroll-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          className="form-input"
          placeholder="123456"
          aria-describedby="mfa-enroll-code-hint"
        />
        <p id="mfa-enroll-code-hint" className="form-hint">
          Masukkan kode 6 digit yang ditampilkan aplikasi autentikator Anda saat ini.
        </p>
      </div>

      <Button
        type="submit"
        loading={busy}
        disabled={lockoutSeconds !== null}
        data-testid="mfa-enroll-confirm"
      >
        Aktifkan
      </Button>
    </form>
  );
}
