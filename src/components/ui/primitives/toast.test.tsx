import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastContainer } from "./toast";
import { ToastProvider, useToast, type ToastType } from "./toast-context";

// The live-region role each toast type carries. Errors interrupt, the rest wait for a pause.
const ROLES: [ToastType, string][] = [
  ["success", "status"],
  ["info", "status"],
  ["error", "alert"],
];

function RaiseToast({ type }: { type: ToastType }) {
  const { addToast } = useToast();

  return (
    <button type="button" onClick={() => addToast({ type, message: `pesan ${type}`, duration: 0 })}>
      munculkan
    </button>
  );
}

describe("the live region and shape of a toast", () => {
  it.each(ROLES)("reads %s as role %s with no title", (type, role) => {
    render(
      <ToastProvider>
        <RaiseToast type={type} />
        <ToastContainer />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "munculkan" }));

    const toast = screen.getByText(`pesan ${type}`).closest("[data-toast-type]");

    expect(toast?.getAttribute("data-toast-type")).toBe(type);
    expect(toast?.getAttribute("role")).toBe(role);
    expect(toast?.querySelector(".toast-label")).toBeNull();
  });
});
