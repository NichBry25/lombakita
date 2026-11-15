"use client";

import { useId, useState } from "react";
import type {
  ComponentProps,
  CSSProperties,
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

// The counter announces to a screen reader only when the length crosses 80, 90 and 100 percent of
// the limit, never on every key. The text is fixed per threshold so it does not change between them.
const ANNOUNCE_AT_FRACTIONS = [0.9, 0.8];

function limitAnnouncementFor(length: number, maxLength: number): string {
  if (length >= maxLength) return `Batas ${maxLength} karakter tercapai.`;
  for (const fraction of ANNOUNCE_AT_FRACTIONS) {
    const threshold = Math.ceil(maxLength * fraction);
    if (length >= threshold) return `Sisa ${maxLength - threshold} karakter`;
  }
  return "";
}

type FormTextareaWithLimitProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "maxLength" | "value"
> & {
  value: string;
  maxLength: number;
  // The field error, shown at the left of the message row and linked to the field.
  error?: string;
};

/**
 * A text area with a character limit: a "{n} / {max}" counter at the right of the message row.
 * At the limit the counter and a message turn to the error colour, with no change to the field's
 * ring, because reaching the limit is not an error. Render it inside a FormField.
 */
export function FormTextareaWithLimit({
  value,
  maxLength,
  error,
  className,
  "aria-describedby": describedBy,
  ...textareaProps
}: FormTextareaWithLimitProps) {
  const counterId = useId();
  const errorId = useId();
  const atLimit = value.length >= maxLength;
  const describedByIds = [describedBy, error ? errorId : undefined, counterId]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <FormTextarea
        {...textareaProps}
        value={value}
        maxLength={maxLength}
        className={className}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds}
      />
      <div className="form-message-row">
        {error ? (
          <FormError id={errorId}>{error}</FormError>
        ) : atLimit ? (
          <p className="form-limit-message">{`Batas ${maxLength} karakter tercapai.`}</p>
        ) : (
          <span />
        )}
        <span id={counterId} className="form-counter" data-at-limit={atLimit ? "true" : undefined}>
          {`${value.length} / ${maxLength}`}
        </span>
      </div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {limitAnnouncementFor(value.length, maxLength)}
      </span>
    </>
  );
}

type SliderProps = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
};

// A native range input, so arrow keys and touch drag are the browser's own. The filled part of
// the track is drawn from the value, which CSS cannot read from the input.
export function Slider({ label, min, max, step, value, onChange }: SliderProps) {
  const inputId = useId();
  const progressPercent = ((value - min) / (max - min)) * 100;
  const progressStyle = { "--slider-progress": `${progressPercent}%` } as CSSProperties;

  return (
    <div className="slider">
      <label className="slider-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={progressStyle}
        onChange={(event) => onChange(parseFloat(event.target.value))}
      />
    </div>
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
