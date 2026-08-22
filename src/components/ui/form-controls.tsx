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

type CheckboxFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  className?: string;
  children: ReactNode;
};

/**
 * The only checkbox in the app.
 *
 * The box and its label are both direct children of the label element, so the row can centre them
 * against each other. Wrapping the pair in a span, which four call sites used to do, makes the
 * whole pair one flex item and the box falls back to sitting on the text baseline instead.
 * Wrapping in .form-label, which two others did, makes the label a block and leaves the box proud
 * of its own sentence.
 *
 * .checkbox-field carries the 44px minimum height, so the tappable area is the whole row rather
 * than the 16px box.
 *
 * `className` styles the ROW; everything else goes to the input, so a caller can pass
 * `defaultChecked`, `aria-describedby`, `name` or `disabled` without a second pattern appearing.
 */
export function CheckboxField({ className, children, id, ...inputProps }: CheckboxFieldProps) {
  return (
    <label className={joinClassNames("checkbox-field", className)} htmlFor={id}>
      <input {...inputProps} id={id} type="checkbox" />
      <span>{children}</span>
    </label>
  );
}
