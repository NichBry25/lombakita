"use client";

import { FormLabel, PasswordField } from "@/components/ui";

const NEW_PASSWORD_MIN_LENGTH = 8;
const NEW_PASSWORD_MAX_LENGTH = 72;

/** The client-side mirror of the server's password rule; the server still decides. */
export const validateNewPassword = (password: string, confirmation: string): string | null => {
  if (password !== confirmation) {
    return "Password dan konfirmasi tidak sama.";
  }

  const length = password.trim().length;
  if (length < NEW_PASSWORD_MIN_LENGTH || length > NEW_PASSWORD_MAX_LENGTH) {
    return "Password harus 8 sampai 72 karakter.";
  }

  return null;
};

type NewPasswordFieldsProps = {
  idPrefix: string;
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
};

export function NewPasswordFields({
  idPrefix,
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
}: NewPasswordFieldsProps) {
  return (
    <>
      <div className="form-field">
        <FormLabel htmlFor={`${idPrefix}-password`} required>
          Password baru
        </FormLabel>
        <PasswordField
          id={`${idPrefix}-password`}
          name="newPassword"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
      </div>

      <div className="form-field">
        <FormLabel htmlFor={`${idPrefix}-confirmation`} required>
          Ulangi password baru
        </FormLabel>
        <PasswordField
          id={`${idPrefix}-confirmation`}
          name="confirmNewPassword"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => onConfirmationChange(event.target.value)}
        />
      </div>
    </>
  );
}
