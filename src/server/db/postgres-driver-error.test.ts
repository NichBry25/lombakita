// @vitest-environment node

import { describe, expect, it } from "vitest";
import { findPostgresDriverError } from "./postgres-driver-error";

describe("findPostgresDriverError", () => {
  it("finds the code on the error itself", () => {
    const error = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint_name: "users_email_unique",
    });

    expect(findPostgresDriverError(error)).toMatchObject({
      code: "23505",
      constraint_name: "users_email_unique",
    });
  });

  it("finds the code on the error's cause", () => {
    const error = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("duplicate"), {
        code: "23505",
        constraint_name: "users_username_unique_idx",
      }),
    });

    expect(findPostgresDriverError(error)).toMatchObject({
      code: "23505",
      constraint_name: "users_username_unique_idx",
    });
  });

  it("returns undefined when no code is present", () => {
    expect(findPostgresDriverError(new Error("plain"))).toBeUndefined();
  });
});
