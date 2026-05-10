// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db/client";
import {
  checkStudentEligibility,
  getStudentEligibilityProfile,
  updateStudentEligibilityProfile,
} from "@/server/eligibility/eligibility-service";

type EligibilityRowFixture = {
  userId: string;
  dateOfBirth: string | null;
  enrollmentStatus: "enrolled" | "on_leave" | "graduated" | "unknown" | null;
  educationLevel: "D3" | "D4" | "S1" | "S2" | "S3" | null;
  universityName: string | null;
  studentIdNumber: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

const eligibleRow = (overrides: Partial<EligibilityRowFixture> = {}): EligibilityRowFixture => ({
  userId: "stud_1",
  dateOfBirth: "2002-03-21",
  enrollmentStatus: "enrolled",
  educationLevel: "S1",
  universityName: "Universitas Indonesia",
  studentIdNumber: "1906345678",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  ...overrides,
});

const createSelectMock = (row: EligibilityRowFixture | null) => {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return { select, spies: { select, from, where, limit } };
};

const createWriteMock = () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  return { insert, spies: { insert, values, onConflictDoUpdate } };
};

const createReadOnlyDb = (row: EligibilityRowFixture | null) => {
  const { select, spies } = createSelectMock(row);
  return { db: { select } as unknown as Database, spies };
};

const createReadWriteDb = (rowAfterWrite: EligibilityRowFixture) => {
  const { select } = createSelectMock(rowAfterWrite);
  const { insert, spies: writeSpies } = createWriteMock();

  return {
    db: { select, insert } as unknown as Database,
    writeSpies,
  };
};

describe("getStudentEligibilityProfile", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns the stored eligibility row when present", async () => {
    const row = eligibleRow();
    const { db } = createReadOnlyDb(row);

    const profile = await getStudentEligibilityProfile("stud_1", db);

    expect(profile.userId).toBe("stud_1");
    expect(profile.dateOfBirth).toBe("2002-03-21");
    expect(profile.enrollmentStatus).toBe("enrolled");
    expect(profile.educationLevel).toBe("S1");
  });

  it("returns an empty shell when no row exists", async () => {
    const { db } = createReadOnlyDb(null);

    const profile = await getStudentEligibilityProfile("stud_1", db);

    expect(profile).toEqual({
      userId: "stud_1",
      dateOfBirth: null,
      enrollmentStatus: null,
      educationLevel: null,
      universityName: null,
      studentIdNumber: null,
      createdAt: null,
      updatedAt: null,
    });
  });
});

describe("checkStudentEligibility", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns eligible when stored row satisfies all rules", async () => {
    const { db } = createReadOnlyDb(eligibleRow());

    const result = await checkStudentEligibility("stud_1", db);

    expect(result.status).toBe("eligible");
    expect(result.reasons).toEqual([]);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("returns ineligible_enrollment when student is graduated", async () => {
    const { db } = createReadOnlyDb(eligibleRow({ enrollmentStatus: "graduated" }));

    const result = await checkStudentEligibility("stud_1", db);

    expect(result.status).toBe("ineligible_enrollment");
    expect(result.reasons).toEqual(["enrollment_status_graduated"]);
  });

  it("returns incomplete when no row exists for the student", async () => {
    const { db } = createReadOnlyDb(null);

    const result = await checkStudentEligibility("stud_1", db);

    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual([
      "missing_date_of_birth",
      "missing_enrollment_status",
      "missing_education_level",
      "missing_university_name",
      "missing_student_id_number",
    ]);
  });

  it("is pure-read — two consecutive calls produce equivalent status", async () => {
    const { db } = createReadOnlyDb(eligibleRow());

    const a = await checkStudentEligibility("stud_1", db);
    const b = await checkStudentEligibility("stud_1", db);

    expect(a.status).toBe(b.status);
    expect(a.reasons).toEqual(b.reasons);
  });
});

describe("updateStudentEligibilityProfile", () => {
  afterEach(() => vi.clearAllMocks());

  it("upserts the patch fields and returns fresh eligibility result", async () => {
    const { db, writeSpies } = createReadWriteDb(eligibleRow());

    const result = await updateStudentEligibilityProfile(
      "stud_1",
      {
        dateOfBirth: "2002-03-21",
        enrollmentStatus: "enrolled",
        educationLevel: "S1",
        universityName: "Universitas Indonesia",
        studentIdNumber: "1906345678",
      },
      db,
    );

    expect(writeSpies.insert).toHaveBeenCalledTimes(1);
    expect(writeSpies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "stud_1",
        dateOfBirth: "2002-03-21",
        enrollmentStatus: "enrolled",
      }),
    );
    expect(result.eligibility.status).toBe("eligible");
    expect(result.profile.userId).toBe("stud_1");
  });

  it("rejects an attempt to set status via PATCH with eligibility_protected_fields", async () => {
    const { db } = createReadWriteDb(eligibleRow());

    await expect(
      updateStudentEligibilityProfile("stud_1", { status: "eligible" }, db),
    ).rejects.toMatchObject({ code: "eligibility_protected_fields" });
  });
});
