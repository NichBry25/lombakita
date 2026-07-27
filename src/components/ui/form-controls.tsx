import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { joinClassNames } from "./class-names";

export function FormField({ children }: { children: ReactNode }) {
  return <div className="form-field">{children}</div>;
}

type FormLabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  required?: boolean;
};

export function FormLabel({ required = false, className, ...labelProps }: FormLabelProps) {
  return (
    <label
      {...labelProps}
      className={joinClassNames("form-label", required && "form-label-required", className)}
    />
  );
}

export function FormInput({
  className,
  readOnly,
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...inputProps}
      readOnly={readOnly}
      className={joinClassNames("form-input", readOnly && "form-input-readonly", className)}
    />
  );
}

export function FormTextarea({
  className,
  readOnly,
  ...textareaProps
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...textareaProps}
      readOnly={readOnly}
      className={joinClassNames("form-textarea", readOnly && "form-input-readonly", className)}
    />
  );
}

export function FormSelect({
  className,
  children,
  ...selectProps
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...selectProps} className={joinClassNames("form-select", className)}>
      {children}
    </select>
  );
}

export function FormHelp({ children }: { children: ReactNode }) {
  return <p className="form-help">{children}</p>;
}
