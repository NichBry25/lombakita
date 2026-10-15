import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import ErrorPage from "./error";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ captureException }));

afterEach(() => {
  vi.restoreAllMocks();
  captureException.mockClear();
  refresh.mockClear();
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

it("refreshes the server segment and resets the boundary once on Coba lagi", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reset = vi.fn();
  const error = Object.assign(new Error("Server rendering failed"), { digest: "server-error" });
  render(<ErrorPage error={error} reset={reset} />);
  expect(reset).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));

  expect(reset).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});
