// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERIFICATION_REFUSAL_COPY,
  resolveVerificationRefusalMessage,
} from "@/lib/institutions/verification-refusal-copy";

// The English prose the server puts in the envelope for this refusal
// (operator-institution-conflict.ts). Duplicated rather than imported: that module is server-only.
const SERVER_ENGLISH =
  "A platform-ops account cannot decide the verification of an institution it has filed for, been invited to, or held any membership in";

describe("resolveVerificationRefusalMessage", () => {
  it("translates the DEC-0220 refusal instead of relaying the server's English", () => {
    const message = resolveVerificationRefusalMessage(
      { code: "operator_actor_conflicted", message: SERVER_ENGLISH },
      "Gagal.",
    );

    expect(message).toBe(VERIFICATION_REFUSAL_COPY.operator_actor_conflicted);
    expect(message).not.toBe(SERVER_ENGLISH);
    expect(message).not.toMatch(/platform-ops|cannot decide/i);
  });

  it("relays the server's message for a code it has no copy for", () => {
    expect(
      resolveVerificationRefusalMessage(
        { code: "verification_not_found", message: "Tidak ada." },
        "Gagal.",
      ),
    ).toBe("Tidak ada.");
  });

  it("falls back when the envelope carries neither a known code nor a message", () => {
    expect(resolveVerificationRefusalMessage(undefined, "Gagal.")).toBe("Gagal.");
    expect(resolveVerificationRefusalMessage({ code: "x" }, "Gagal.")).toBe("Gagal.");
  });
});

// Both operator surfaces that decide a verification show this refusal, so both read the envelope
// through the helper. A page that went back to `error.message` would show the English again.
describe("the operator verification surfaces", () => {
  it.each(["src/app/admin/verification/page.tsx", "src/app/admin/institutions/page.tsx"])(
    "%s resolves a refusal through the helper",
    (path) => {
      const source = readFileSync(join(process.cwd(), path), "utf8");

      expect(source).toContain("resolveVerificationRefusalMessage(");
    },
  );
});
