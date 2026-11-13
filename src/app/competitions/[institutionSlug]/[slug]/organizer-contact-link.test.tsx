// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: ({ children, href, ...rest }: { children: unknown; href: string }) =>
      React.createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  };
});

import { OrganizerContactLink } from "./organizer-contact-link";

describe("OrganizerContactLink", () => {
  it("opens a WhatsApp chat with the number in 62 form, in a new tab", () => {
    const html = renderToStaticMarkup(
      <OrganizerContactLink contact={{ kind: "whatsapp", value: "6281234567890" }} />,
    );

    expect(html).toContain('href="https://wa.me/6281234567890"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("<span>Hubungi penyelenggara</span>");
    expect(html).toContain('WhatsApp: <span class="data-text">+6281234567890</span>');
  });

  it("starts a call for a Telepon contact", () => {
    const html = renderToStaticMarkup(
      <OrganizerContactLink contact={{ kind: "phone", value: "6281234567890" }} />,
    );

    expect(html).toContain('href="tel:+6281234567890"');
    expect(html).toContain('Telepon: <span class="data-text">+6281234567890</span>');
    expect(html).not.toContain("target=");
  });

  it("opens an email for an Email contact", () => {
    const html = renderToStaticMarkup(
      <OrganizerContactLink contact={{ kind: "email", value: "panitia@example.test" }} />,
    );

    expect(html).toContain('href="mailto:panitia@example.test"');
    expect(html).toContain('Email: <span class="data-text">panitia@example.test</span>');
  });
});
