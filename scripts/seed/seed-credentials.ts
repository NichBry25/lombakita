/**
 * The password every seeded account signs in with, hashed the way production hashes it.
 *
 * The password is published on purpose: it is fixture data for a local database, printed at the end
 * of every seed run and read by the testing lane. The hash is produced by the application's own
 * `hashPassword`, which salts each call from `randomBytes`, so nothing about the stored hash is
 * reproducible from this source. An earlier seed mirrored the format with a fixed salt so re-runs
 * would produce an identical hash; nothing needed that, and it made a copy of the hash recognisable
 * wherever it turned up.
 */
import { hashPassword } from "@/server/auth/password";

export const SEED_PASSWORD = "UjiCoba123!";

export const hashSeedPassword = (): Promise<string> => hashPassword(SEED_PASSWORD);
