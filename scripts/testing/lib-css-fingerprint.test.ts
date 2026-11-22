import { describe, expect, it } from "vitest";
import {
  BROWSER_DROPPED_PSEUDO_PREFIXES,
  canonicalSelector,
  readStylesheetSources,
  sourceTokens,
} from "./lib-css-fingerprint.mjs";

const isDroppedByAuditBrowser = (selector: string): boolean =>
  BROWSER_DROPPED_PSEUDO_PREFIXES.some((prefix) => canonicalSelector(selector).includes(prefix));

describe("canonicalSelector", () => {
  it("reads odd and even the way Chromium serialises them", () => {
    expect(canonicalSelector(".a:nth-child(odd)")).toBe(canonicalSelector(".a:nth-child(2n+1)"));
    expect(canonicalSelector(".a:nth-of-type(even)")).toBe(canonicalSelector(".a:nth-of-type(2n)"));
    expect(canonicalSelector(".form-grid > .form-field:last-child:nth-child(odd)::after")).toBe(
      canonicalSelector(".form-grid > .form-field:last-child:nth-child(2n+1)::after"),
    );
  });
});

describe("BROWSER_DROPPED_PSEUDO_PREFIXES", () => {
  it("matches a Firefox-only pseudo-element and not a WebKit one", () => {
    expect(isDroppedByAuditBrowser(".slider-input:-moz-range-thumb")).toBe(true);
    expect(isDroppedByAuditBrowser(".slider-input:-webkit-slider-thumb")).toBe(false);
  });
});

describe("sourceTokens", () => {
  it("reads a token only from a theme root block", () => {
    const text = [
      '[data-theme="dark"] { --a: 1px; }',
      '[data-theme="dark"] .x { --b: 2px; }',
      ':root, [data-theme="light"] { --c: 3px; }',
    ].join("\n");

    const tokens = sourceTokens([{ path: "hand-built.css", text }]);

    expect([...tokens.dark.keys()]).toEqual(["--a"]);
    expect([...tokens.light.keys()]).toEqual(["--c"]);
  });

  it("reads the real stylesheets without taking a component token as a root token", () => {
    const tokens = sourceTokens(readStylesheetSources());

    expect(tokens.light.size).toBe(389);
    expect(tokens.dark.size).toBe(112);
    expect(tokens.dark.has("--table-head-fill")).toBe(false);
  });
});
