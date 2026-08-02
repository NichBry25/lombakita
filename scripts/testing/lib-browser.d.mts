/**
 * Types for lib-browser.mjs, so TypeScript scripts elsewhere under scripts/ can drive a real
 * browser session. The .mjs file stays the implementation; this only describes its shape.
 */

import type { Browser, BrowserContext, Page } from "playwright";

export declare const DESKTOP: { width: number; height: number };
export declare const MOBILE: { width: number; height: number };

export declare function launch(): Promise<Browser>;

/** Browser context carrying a real session for `email` (null = signed out). */
export declare function contextFor(browser: Browser, email: string | null): Promise<BrowserContext>;

export declare function setTheme(page: Page, theme: "light" | "dark"): Promise<void>;

export declare function visit(
  page: Page,
  path: string,
  options?: { waitMs?: number },
): Promise<{ url: string; status: number | null }>;

export declare function shot(page: Page, file: string): Promise<void>;
