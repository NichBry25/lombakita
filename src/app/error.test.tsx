import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import ErrorPage from "./error";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ captureException }));

afterEach(() => {
  vi.restoreAllMocks();
  captureException.mockClear();
});

it("captures the render error beside the existing console report", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("render-sentinel");
  const reset = vi.fn();
  const view = render(<ErrorPage error={error} reset={reset} />);
  expect(consoleError).toHaveBeenCalledWith(error);
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(error);
  expect(screen.getByRole("heading").textContent).toBe("Terjadi kesalahan.");
  screen.getByRole("button", { name: "Coba lagi" }).click();
  expect(reset).toHaveBeenCalledTimes(1);
  const nextError = new Error("next-render-sentinel");
  view.rerender(<ErrorPage error={nextError} reset={reset} />);
  expect(captureException).toHaveBeenCalledTimes(2);
  expect(captureException).toHaveBeenLastCalledWith(nextError);
});
