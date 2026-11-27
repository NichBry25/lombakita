"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Feedback, FormInput, FormLabel } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { errorMessageFor, NETWORK_ERROR_MESSAGE } from "@/lib/errors/error-copy";
import {
  CODE_CHECK_UNAVAILABLE_MESSAGE,
  CODE_EXPIRED_MESSAGE,
  CODE_LOCKED_MESSAGE,
  codeInvalidMessage,
  DAILY_LIMIT_MESSAGE,
  DOMAIN_TRY_LIMIT_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
  FREE_DOMAIN_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  NO_CODE_MESSAGE,
  resendTooSoonMessage,
} from "@/lib/host-trust/organization-email-messages";
import { sessionFetch } from "@/lib/session/session-fetch";

const CODE_URL = "/api/v1/me/organization-email/code";
const CONFIRM_URL = "/api/v1/me/organization-email/confirm";

// The code route refuses a second code to the same address within 60 seconds.
const RESEND_COOLDOWN_SECONDS = 60;

const SEND_FALLBACK = "Kode belum dapat dikirim. Coba lagi beberapa saat.";
const CONFIRM_FALLBACK = "Kode belum dapat dicocokkan. Coba lagi beberapa saat.";

const ORGANIZATION_EMAIL_ERROR_COPY: Partial<Record<string, string>> = {
  organization_email_invalid: INVALID_EMAIL_MESSAGE,
  organization_email_free_domain: FREE_DOMAIN_MESSAGE,
  organization_email_daily_limit: DAILY_LIMIT_MESSAGE,
  organization_email_code_expired: CODE_EXPIRED_MESSAGE,
  organization_email_code_locked: CODE_LOCKED_MESSAGE,
  organization_email_no_code: NO_CODE_MESSAGE,
  organization_email_taken: EMAIL_TAKEN_MESSAGE,
};

// organization_email_code_locked has three causes and the server's sentence names the one that
// applies. Only a sentence held here is shown, so no other server text reaches the page.
const CODE_LOCKED_SENTENCES = new Set([
  CODE_LOCKED_MESSAGE,
  DOMAIN_TRY_LIMIT_MESSAGE,
  CODE_CHECK_UNAVAILABLE_MESSAGE,
]);

type Refusal = {
  code?: string;
  message?: string;
  details?: { retryAfterSeconds?: number; attemptsLeft?: number };
};

const refusalSentence = (refusal: Refusal | undefined, fallback: string): string => {
  const retryAfterSeconds = refusal?.details?.retryAfterSeconds;
  if (refusal?.code === "organization_email_resend_too_soon" && retryAfterSeconds !== undefined) {
    return resendTooSoonMessage(retryAfterSeconds);
  }
  const attemptsLeft = refusal?.details?.attemptsLeft;
  if (refusal?.code === "organization_email_code_invalid" && attemptsLeft !== undefined) {
    return codeInvalidMessage(attemptsLeft);
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

// The code route normalizes an address the same way before it keys the resend wait on it.
const normalizedAddress = (typed: string): string => typed.trim().toLowerCase();

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
  // Called after a confirm, with whether that confirm made the account trusted.
  onConfirmed?: (hostTrusted: boolean) => void;
};

export function OrganizationEmailField({
  expectedUserId,
  onConfirmed,
}: OrganizationEmailFieldProps) {
  const { addToast } = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"send" | "confirm" | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const codeInputRef = useRef<HTMLInputElement>(null);

  // The resend wait holds only the address the last code went to, so a corrected address goes out
  // at once.
  const typedAddressWasSent = sentTo !== null && normalizedAddress(email) === sentTo;

  const secondsUntilResend =
    lastSentAt === null || !typedAddressWasSent
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

  // A resend refused as too soon means a code to this address is still live, so the code box opens
  // with the wait the server named.
  const openCodeBoxForLiveCode = (refusal: Refusal | undefined): void => {
    const retryAfterSeconds = refusal?.details?.retryAfterSeconds;
    if (refusal?.code !== "organization_email_resend_too_soon" || retryAfterSeconds === undefined) {
      return;
    }
    const refusedAt = Date.now();
    setNow(refusedAt);
    setLastSentAt(refusedAt - (RESEND_COOLDOWN_SECONDS - retryAfterSeconds) * 1000);
    setSentTo(normalizedAddress(email));
  };

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
        openCodeBoxForLiveCode(refusal);
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
      const payload = (await response.json()) as {
        organizationEmail: { email: string; trustSource: string | null };
      };
      setConfirmedEmail(payload.organizationEmail.email);
      onConfirmed?.(payload.organizationEmail.trustSource !== null);
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
          <SendCodeLabel hasSent={typedAddressWasSent} secondsUntilResend={secondsUntilResend} />
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
