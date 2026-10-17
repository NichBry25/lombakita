"use client";

import { useState, type FormEvent } from "react";
import { Button, usePageTransition } from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { NewPasswordFields, validateNewPassword } from "@/components/auth/new-password-fields";
import { ResetLinkErrorState } from "./reset-link-error-state";

const CONNECTION_MESSAGE = "Terjadi gangguan koneksi. Coba lagi beberapa saat.";
const GENERIC_MESSAGE = "Terjadi kesalahan. Coba lagi beberapa saat.";
const INVALID_PASSWORD_MESSAGE = "Password harus 8 sampai 72 karakter.";
const DEAD_LINK_CODES = ["password_reset_token_invalid", "password_reset_token_expired"];

type ResetPasswordFormProps = {
  token: string;
};

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const { addToast } = useToast();
  const { begin } = usePageTransition();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkIsDead, setLinkIsDead] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const problem = validateNewPassword(password, confirmation);
    if (problem) {
      addToast({ type: "error", message: problem });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (response.ok) {
        begin("Menyimpan…");
        window.location.assign("/auth/login?passwordChanged=1");
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      const code = payload?.error?.code ?? "";

      if (DEAD_LINK_CODES.includes(code)) {
        setLinkIsDead(true);
        return;
      }

      const message = code === "invalid_password" ? INVALID_PASSWORD_MESSAGE : GENERIC_MESSAGE;
      addToast({ type: "error", message });
      setBusy(false);
    } catch {
      addToast({ type: "error", message: CONNECTION_MESSAGE });
      setBusy(false);
    }
  };

  if (linkIsDead) {
    return <ResetLinkErrorState title="Tautan atur ulang tidak valid atau sudah kedaluwarsa" />;
  }

  return (
    <form onSubmit={onSubmit} className="auth-form stack-md">
      <header className="auth-entry-header">
        <h1>Buat password baru</h1>
      </header>

      <NewPasswordFields
        idPrefix="reset"
        password={password}
        confirmation={confirmation}
        onPasswordChange={setPassword}
        onConfirmationChange={setConfirmation}
      />

      <Button type="submit" loading={busy}>
        Simpan password baru
      </Button>
    </form>
  );
}
