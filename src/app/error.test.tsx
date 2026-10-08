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

it("keeps the console report without recapturing an error with a server digest", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(new Error("server-render-sentinel"), { digest: "server-digest" });
  render(<ErrorPage error={error} reset={vi.fn()} />);
  expect(consoleError).toHaveBeenCalledTimes(1);
  expect(consoleError).toHaveBeenCalledWith(error);
  expect(captureException).not.toHaveBeenCalled();
});

it("captures an error with an empty digest once", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(new Error("browser-render-sentinel"), { digest: "" });
  render(<ErrorPage error={error} reset={vi.fn()} />);
  expect(captureException).toHaveBeenCalledTimes(1);
  expect(captureException).toHaveBeenCalledWith(error);
});
