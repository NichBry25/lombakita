import { render } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalDate } from "./local-date";

describe("LocalDate", () => {
  const previousTimeZone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  });

  it("renders WIB in the server HTML", () => {
    const html = renderToStaticMarkup(
      <LocalDate value="2026-11-20T16:30:00Z" format="longDateTime" />,
    );
    expect(html).toBe(
      '<time dateTime="2026-11-20T16:30:00.000Z">20 November 2026 pukul 23.30</time>',
    );
  });

  it("switches to the device's time after hydration without a hydration error", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <LocalDate value="2026-11-20T16:30:00Z" format="longDateTime" />,
    );
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    await act(async () => {
      hydrateRoot(container, <LocalDate value="2026-11-20T16:30:00Z" format="longDateTime" />, {
        onRecoverableError,
      });
    });
    expect(container.textContent).toBe("20 November 2026 pukul 16.30");
    expect(onRecoverableError).not.toHaveBeenCalled();
    container.remove();
  });

  it("shows a dash for an unreadable date", () => {
    render(<LocalDate value="not a date" format="longDate" />);
    expect(document.body.textContent).toContain("—");
    expect(document.querySelector("time")).toBeNull();
  });
});
