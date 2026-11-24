"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Feedback, FormInput, FormLabel } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import { sessionFetch } from "@/lib/session/session-fetch";

const CODE_URL = "/api/v1/me/organization-email/code";
const CONFIRM_URL = "/api/v1/me/organization-email/confirm";

// The code route refuses a second code to the same address within 60 seconds.
const RESEND_COOLDOWN_SECONDS = 60;

const SEND_FALLBACK = "Kode belum dapat dikirim. Coba lagi beberapa saat.";
const CONFIRM_FALLBACK = "Kode belum dapat dicocokkan. Coba lagi beberapa saat.";

const ORGANIZATION_EMAIL_ERROR_COPY: Partial<Record<string, string>> = {
  organization_email_invalid: "Alamat email belum benar. Periksa lagi penulisannya.",
  organization_email_free_domain:
    "Pakai email dengan domain organisasi Anda, bukan email pribadi seperti Gmail atau email sementara.",
  organization_email_daily_limit: "Batas pengiriman kode hari ini sudah tercapai. Coba lagi besok.",
  organization_email_code_expired: "Kode sudah kedaluwarsa. Minta kode baru.",
  organization_email_code_locked: "Kode salah 5 kali. Minta kode baru.",
  organization_email_no_code: "Belum ada kode yang aktif. Minta kode terlebih dahulu.",
  organization_email_taken:
    "Email ini sudah dipakai akun lain. Satu email organisasi hanya untuk satu akun.",
};

// organization_email_code_locked has three causes and the server's sentence names the one that
// applies. Only a sentence held here is shown, so no other server text reaches the page.
const CODE_LOCKED_SENTENCES = new Set([
  "Kode salah 5 kali. Minta kode baru.",
  "Terlalu banyak percobaan kode untuk domain email ini hari ini. Coba lagi besok.",
  "Kode belum dapat diperiksa saat ini. Tunggu beberapa menit sebelum mencoba lagi, atau minta kode baru.",
]);

type Refusal = {
  code?: string;
  message?: string;
  details?: { retryAfterSeconds?: number; attemptsLeft?: number };
};

const refusalSentence = (refusal: Refusal | undefined, fallback: string): string => {
  const retryAfterSeconds = refusal?.details?.retryAfterSeconds;
  if (refusal?.code === "organization_email_resend_too_soon" && retryAfterSeconds !== undefined) {
    return `Tunggu ${retryAfterSeconds} detik sebelum meminta kode baru.`;
  }
  const attemptsLeft = refusal?.details?.attemptsLeft;
  if (refusal?.code === "organization_email_code_invalid" && attemptsLeft !== undefined) {
    return `Kode tidak cocok. Sisa percobaan: ${attemptsLeft}.`;
  }
  const message = refusal?.message;
  const isLocked = refusal?.code === "organization_email_code_locked";
  if (isLocked && message !== undefined && CODE_LOCKED_SENTENCES.has(message)) {
    return message;
  }
  return errorMessageFor(refusal?.code, ORGANIZATION_EMAIL_ERROR_COPY, fallback);
};

const readRefusal = async (response: Response): Promise<Refusal | undefined> => {
  const payload = (await response.json().catch(() => null)) as { error?: Refusal } | null;
  return payload?.error;
};

// The send button names the next send: the first one, the wait before a resend, or the resend.
function SendCodeLabel({
  hasSent,
  secondsUntilResend,
}: {
  hasSent: boolean;
  secondsUntilResend: number;
}) {
  if (!hasSent) {
    return <>Kirim kode</>;
  }
  if (secondsUntilResend > 0) {
    return (
      <>
        Kirim ulang dalam <span className="data-text">{secondsUntilResend}</span> detik
      </>
    );
  }
  return <>Kirim ulang kode</>;
}

type OrganizationEmailFieldProps = {
  expectedUserId: string;
};

export function OrganizationEmailField({ expectedUserId }: OrganizationEmailFieldProps) {
  const { addToast } = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"send" | "confirm" | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const codeInputRef = useRef<HTMLInputElement>(null);

  const secondsUntilResend =
    lastSentAt === null
      ? 0
      : Math.max(0, Math.ceil((lastSentAt + RESEND_COOLDOWN_SECONDS * 1000 - now) / 1000));

  useEffect(() => {
    if (secondsUntilResend <= 0) return;
    const handle = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(handle);
  }, [secondsUntilResend, now]);

  // The code box appears after the first send, so focus moves to it.
  useEffect(() => {
    if (sentTo !== null) {
      codeInputRef.current?.focus();
    }
  }, [sentTo]);

  const sendCode = async (): Promise<void> => {
    setPendingAction("send");
    try {
      const response = await sessionFetch(expectedUserId, CODE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!response.ok) {
        const refusal = await readRefusal(response);
        addToast({ type: "error", message: refusalSentence(refusal, SEND_FALLBACK) });
        return;
      }
      const payload = (await response.json()) as { organizationEmailCode: { email: string } };
      const sentAt = Date.now();
      setNow(sentAt);
      setLastSentAt(sentAt);
      setCode("");
      setSentTo(payload.organizationEmailCode.email);
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
    } finally {
      setPendingAction(null);
    }
  };

  const confirmCode = async (): Promise<void> => {
    setPendingAction("confirm");
    try {
      const response = await sessionFetch(expectedUserId, CONFIRM_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const refusal = await readRefusal(response);
        addToast({ type: "error", message: refusalSentence(refusal, CONFIRM_FALLBACK) });
        return;
      }
      const payload = (await response.json()) as { organizationEmail: { email: string } };
      setConfirmedEmail(payload.organizationEmail.email);
    } catch {
      addToast({ type: "error", message: NETWORK_ERROR_MESSAGE });
    } finally {
      setPendingAction(null);
    }
  };

  const onSubmitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendCode();
  };

  const onSubmitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void confirmCode();
  };

  if (confirmedEmail !== null) {
    return (
      <Feedback tone="success">Email organisasi {confirmedEmail} sudah terkonfirmasi.</Feedback>
    );
  }

  return (
    <div className="stack-md">
      <form onSubmit={onSubmitEmail} className="stack-sm">
        <div className="form-field">
          <FormLabel htmlFor="organization-email" optional>
            Email organisasi
          </FormLabel>
          <FormInput
            id="organization-email"
            name="organizationEmail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="nama@kampus.ac.id"
            aria-describedby="organization-email-help"
          />
          <p id="organization-email-help" className="form-help">
            Pakai email dengan domain organisasi Anda, misalnya nama@kampus.ac.id. Setelah kodenya
            cocok, kompetisi Anda langsung tayang tanpa menunggu pemeriksaan staf.
          </p>
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          loading={pendingAction === "send"}
          disabled={secondsUntilResend > 0 || pendingAction === "confirm"}
        >
          <SendCodeLabel hasSent={lastSentAt !== null} secondsUntilResend={secondsUntilResend} />
        </Button>
      </form>

      {sentTo !== null ? (
        <form onSubmit={onSubmitCode} className="stack-sm">
          <div className="form-field">
            <FormLabel htmlFor="organization-email-code" required>
              Kode 6 angka
            </FormLabel>
            <FormInput
              ref={codeInputRef}
              id="organization-email-code"
              name="organizationEmailCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              aria-describedby="organization-email-code-help"
            />
            <p id="organization-email-code-help" className="form-help">
              Kode dikirim ke {sentTo} dan berlaku 10 menit.
            </p>
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            loading={pendingAction === "confirm"}
            disabled={pendingAction === "send"}
          >
            Cocokkan kode
          </Button>
        </form>
      ) : null}
    </div>
  );
}
