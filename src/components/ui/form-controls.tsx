"use client";

import { useState } from "react";
import type {
  ComponentProps,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { IconButton } from "./button";
import { joinClassNames } from "./class-names";
import { Icon } from "./icon";

export function FormField({ children }: { children: ReactNode }) {
  return <div className="form-field">{children}</div>;
}

type FieldMarkerProps = {
  required: boolean;
  optional: boolean;
};

// A required field reads "(wajib)" to a screen reader, the same words SelectField announces, and
// the asterisk is only for the eye.
function FieldMarker({ required, optional }: FieldMarkerProps) {
  if (required) {
    return (
      <>
        <span className="form-label-marker" aria-hidden="true">
          {" *"}
        </span>
        <span className="sr-only"> (wajib)</span>
      </>
    );
  }
  if (optional) {
    return <span className="form-label-optional">{" (opsional)"}</span>;
  }
  return null;
}

type FormLabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  required?: boolean;
  optional?: boolean;
};

export function FormLabel({
  required = false,
  optional = false,
  className,
  children,
  ...labelProps
}: FormLabelProps) {
  return (
    <label {...labelProps} className={joinClassNames("form-label", className)}>
      {children}
      <FieldMarker required={required} optional={optional} />
    </label>
  );
}

type FormLabelTextProps = {
  as?: "span" | "p" | "legend";
  id?: string;
  required?: boolean;
  optional?: boolean;
  className?: string;
  children: ReactNode;
};

// The label of a field whose control sits inside a wrapping <label>, or of a group of controls,
// where a second <label> element would be invalid.
export function FormLabelText({
  as: Element = "span",
  required = false,
  optional = false,
  className,
  children,
  id,
}: FormLabelTextProps) {
  return (
    <Element id={id} className={joinClassNames("form-label", className)}>
      {children}
      <FieldMarker required={required} optional={optional} />
    </Element>
  );
}

// A locked value is read-only: it is selectable, copyable and submitted, and the lock says so.
export function FormInput({ className, readOnly, ...inputProps }: ComponentProps<"input">) {
  const input = (
    <input
      {...inputProps}
      readOnly={readOnly}
      className={joinClassNames("form-input", readOnly && "form-input-readonly", className)}
    />
  );
  if (!readOnly) {
    return input;
  }
  return (
    <span className="form-input-lock-wrap">
      {input}
      <Icon name="lock" className="form-input-lock" />
    </span>
  );
}

type PasswordFieldProps = Omit<ComponentProps<"input">, "type">;

// Showing the password only changes the input type, so the typed value is never cleared and the
// toggle never submits the form.
export function PasswordField({ className, ...inputProps }: PasswordFieldProps) {
  const [isShown, setIsShown] = useState(false);
  const toggleLabel = isShown ? "Sembunyikan password" : "Tampilkan password";

  return (
    <div className="form-password-wrap">
      <FormInput
        {...inputProps}
        type={isShown ? "text" : "password"}
        className={joinClassNames("form-password-input", className)}
      />
      <IconButton
        variant="plain"
        icon={isShown ? "eye-off" : "eye"}
        label={toggleLabel}
        className="form-password-toggle"
        onClick={() => setIsShown((shown) => !shown)}
      />
    </div>
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

type FormErrorProps = {
  id?: string;
  children: ReactNode;
};

// A span so it is valid inside the wrapping <label> that some fields use.
export function FormError({ id, children }: FormErrorProps) {
  return (
    <span className="form-error" id={id} role="alert">
      <Icon name="alert-circle" className="form-error-icon" />
      <span>{children}</span>
    </span>
  );
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
 * than the 24px box. The real input stays in the row, drawn as the box itself, so the keyboard
 * and form behaviour is the browser's own.
 *
 * `className` styles the ROW; everything else goes to the input, so a caller can pass
 * `defaultChecked`, `aria-describedby`, `name` or `disabled` without a second pattern appearing.
 */
export function CheckboxField({ className, children, id, ...inputProps }: CheckboxFieldProps) {
  return (
    <label className={joinClassNames("checkbox-field", className)} htmlFor={id}>
      <input {...inputProps} id={id} type="checkbox" />
      <Icon name="check" className="checkbox-field-check" />
      <span>{children}</span>
    </label>
  );
}

type ChoiceCardProps = {
  title: string;
  description: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

// A button with radio semantics, not a native radio: arrow keys on a native radio change the
// choice, and a choice that is acted on at once would then fire as the reader merely moves along
// the group. Put the cards in an element with role="radiogroup" and an accessible name.
export function ChoiceCard({
  title,
  description,
  selected = false,
  disabled = false,
  onSelect,
}: ChoiceCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className="choice-card"
      onClick={onSelect}
    >
      <span className="choice-card-text">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <span className="choice-card-indicator" aria-hidden="true">
        <Icon name="check" />
      </span>
    </button>
  );
}

/**
 * One tag choice, drawn as a pill. It keeps a checkbox per tag, so the semantics and the keyboard
 * behaviour are the checkbox's own.
 */
export function TagChoiceChip({ className, children, id, ...inputProps }: CheckboxFieldProps) {
  return (
    <label className={joinClassNames("tag-choice-chip", className)} htmlFor={id}>
      <input {...inputProps} id={id} type="checkbox" />
      <Icon name="check" className="tag-choice-chip-check" />
      <span>{children}</span>
    </label>
  );
}
