"use client";

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
        <label className="form-label form-label-required" htmlFor={`${idPrefix}-password`}>
          Password baru
        </label>
        <input
          id={`${idPrefix}-password`}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          className="form-input"
        />
      </div>

      <div className="form-field">
        <label className="form-label form-label-required" htmlFor={`${idPrefix}-confirmation`}>
          Ulangi password baru
        </label>
        <input
          id={`${idPrefix}-confirmation`}
          name="confirmNewPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => onConfirmationChange(event.target.value)}
          className="form-input"
        />
      </div>
    </>
  );
}
