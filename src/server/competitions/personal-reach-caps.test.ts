// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime/assert-server-only", () => ({ assertServerOnly: vi.fn() }));

import type { Database } from "@/server/db/client";
import { CompetitionError } from "@/server/competitions/competition-core";
import {
  assertPersonalCompetitionPublishable,
  assertPersonalInstitutionIndividualMode,
} from "@/server/competitions/competition-access";

// Sequenced db: each awaited terminal (.limit for the type read, .where for the count) consumes
// the next queued result in order.
const makeSequencedDb = (results: unknown[][]): Database => {
  let idx = 0;
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) {
      n[m] = () => node();
    }
    n.then = (resolve: (v: unknown) => void) => resolve(results[idx++] ?? []);
    return n;
  };
  return { select: () => node() } as unknown as Database;
};

describe("assertPersonalInstitutionIndividualMode", () => {
  it("rejects team mode for a personal institution (422)", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }]]);
    await expect(assertPersonalInstitutionIndividualMode("inst_p", "team", db)).rejects.toMatchObject(
      { code: "competition_personal_individual_only", httpStatus: 422 },
    );
  });

  it("rejects both mode for a personal institution (422)", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }]]);
    await expect(assertPersonalInstitutionIndividualMode("inst_p", "both", db)).rejects.toThrow(
      CompetitionError,
    );
  });

  it("allows individual mode for a personal institution", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }]]);
    await expect(
      assertPersonalInstitutionIndividualMode("inst_p", "individual", db),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for a full (NULL-type) institution even with team mode", async () => {
    const db = makeSequencedDb([[{ institutionType: null }]]);
    await expect(
      assertPersonalInstitutionIndividualMode("inst_full", "team", db),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for a declared full subtype with team mode", async () => {
    const db = makeSequencedDb([[{ institutionType: "company" }]]);
    await expect(
      assertPersonalInstitutionIndividualMode("inst_company", "team", db),
    ).resolves.toBeUndefined();
  });

  it("throws 404 when the institution does not exist", async () => {
    const db = makeSequencedDb([[]]);
    await expect(assertPersonalInstitutionIndividualMode("inst_x", "individual", db)).rejects.toMatchObject(
      { code: "competition_not_found", httpStatus: 404 },
    );
  });
});

describe("assertPersonalCompetitionPublishable", () => {
  const comp = (mode: "individual" | "team" | null = "individual") => ({
    id: "comp_1",
    institutionId: "inst_p",
    mode,
  });

  it("rejects publishing a 3rd competition for a personal institution (422)", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }], [{ count: 2 }]]);
    await expect(assertPersonalCompetitionPublishable(comp(), db)).rejects.toMatchObject({
      code: "competition_personal_publish_limit",
      httpStatus: 422,
    });
  });

  it("allows publishing when the personal institution has 1 published competition", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }], [{ count: 1 }]]);
    await expect(assertPersonalCompetitionPublishable(comp(), db)).resolves.toBeUndefined();
  });

  it("allows publishing when the personal institution has 0 published competitions", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }], [{ count: 0 }]]);
    await expect(assertPersonalCompetitionPublishable(comp(), db)).resolves.toBeUndefined();
  });

  it("rejects a non-individual personal competition before counting (defense in depth)", async () => {
    const db = makeSequencedDb([[{ institutionType: "personal" }]]);
    await expect(assertPersonalCompetitionPublishable(comp("team"), db)).rejects.toMatchObject({
      code: "competition_personal_individual_only",
      httpStatus: 422,
    });
  });

  it("is a no-op for a full (NULL-type) institution regardless of published count", async () => {
    const db = makeSequencedDb([[{ institutionType: null }]]);
    await expect(assertPersonalCompetitionPublishable(comp(), db)).resolves.toBeUndefined();
  });
});
