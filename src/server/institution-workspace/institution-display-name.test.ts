// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getInstitutionDisplayName } from "@/server/institution-workspace/institution-display-name";

describe("getInstitutionDisplayName", () => {
  it("returns the stored name for a full institution (NULL type / legacy), ignoring the owner", () => {
    expect(
      getInstitutionDisplayName(
        { displayName: "Universitas Nusantara", institutionType: null },
        { username: "someone" },
      ),
    ).toBe("Universitas Nusantara");
  });

  it("returns the stored name for a declared full subtype", () => {
    expect(
      getInstitutionDisplayName(
        { displayName: "Yayasan Cendekia", institutionType: "foundation" },
        null,
      ),
    ).toBe("Yayasan Cendekia");
  });

  it("derives a personal institution name from the owner username, ignoring any stored value", () => {
    expect(
      getInstitutionDisplayName(
        { displayName: null, institutionType: "personal" },
        { username: "owneruser" },
      ),
    ).toBe("owneruser's Institution");

    // A stray stored value must never leak — the derived name is authoritative for personal.
    expect(
      getInstitutionDisplayName(
        { displayName: "leftover", institutionType: "personal" },
        { username: "owneruser" },
      ),
    ).toBe("owneruser's Institution");
  });

  it("falls back to a stable placeholder for a personal institution with no resolved owner", () => {
    expect(
      getInstitutionDisplayName({ displayName: null, institutionType: "personal" }, null),
    ).toBe("Personal Institution");
    expect(
      getInstitutionDisplayName(
        { displayName: null, institutionType: "personal" },
        { username: null },
      ),
    ).toBe("Personal Institution");
  });

  it("reflects an owner username change in the resolved personal name at the next read", () => {
    const personal = { displayName: null, institutionType: "personal" as const };

    const before = getInstitutionDisplayName(personal, { username: "oldname" });
    const after = getInstitutionDisplayName(personal, { username: "newname" });

    expect(before).toBe("oldname's Institution");
    expect(after).toBe("newname's Institution");
    expect(before).not.toBe(after);
  });
});
