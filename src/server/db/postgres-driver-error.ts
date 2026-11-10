export type PostgresDriverError = {
  code: string;
  constraint_name?: string;
  constraint?: string;
  detail?: string;
};

// drizzle 0.44 wraps the driver's error, so the Postgres code and constraint sit on a cause, not on the caught error.
export const findPostgresDriverError = (error: unknown): PostgresDriverError | undefined => {
  let current: unknown = error;

  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as Partial<PostgresDriverError> & { cause?: unknown };
    if (typeof candidate.code === "string") {
      return candidate as PostgresDriverError;
    }
    current = candidate.cause;
  }

  return undefined;
};
