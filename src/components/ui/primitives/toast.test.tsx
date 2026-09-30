import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastContainer } from "./toast";
import { ToastProvider, useToast, type ToastType } from "./toast-context";

// The word each toast type carries above its message. Every screen that raises a toast reads this
// table through `ToastContainer`, so a label changed here changes it everywhere at once.
const LABELS: [ToastType, string][] = [
  ["success", "Berhasil"],
  ["info", "Info"],
  ["warning", "Peringatan"],
  ["error", "Gagal"],
];

function RaiseToast({ type }: { type: ToastType }) {
  const { addToast } = useToast();

  return (
    <button type="button" onClick={() => addToast({ type, message: `pesan ${type}`, duration: 0 })}>
      munculkan
    </button>
  );
}

describe("the label a toast carries above its message", () => {
  it.each(LABELS)("reads %s as %s", (type, label) => {
    render(
      <ToastProvider>
        <RaiseToast type={type} />
        <ToastContainer />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "munculkan" }));

    const toast = screen.getByText(`pesan ${type}`).closest("[data-toast-type]");

    expect(toast?.getAttribute("data-toast-type")).toBe(type);
    expect(toast?.querySelector(".toast-label")?.textContent).toBe(label);
  });
});
