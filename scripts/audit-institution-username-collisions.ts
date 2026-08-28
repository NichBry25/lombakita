/**
 * Read-only audit: find full (non-personal) institutions whose slug collides with an existing
 * user's username under the shared flat namespace.
 *
 * Usernames and institution slugs share one namespace. A username is stored lowercase over
 * [a-z0-9_] (no hyphens, no diacritics), so its slug form is exactly `_`→`-`. This audit normalizes
 * each side the same way and reports any full-institution slug that matches a username's slug form.
 * Personal institutions are excluded (institution_type = 'personal'); NULL/legacy types count as
 * full (institution_type IS DISTINCT FROM 'personal'), matching the runtime predicate.
 *
 * Fix C prevents NEW collisions on full-institution creation; it does not resolve pre-existing rows.
 * This script surfaces them so platform_ops can decide per row (leave as-is, rename the institution
 * slug, or have the user rename). It changes nothing.
 *
 * Usage: npx tsx scripts/audit-institution-username-collisions.ts
 * Exit code: 0 when no collisions; 1 when one or more collisions are found.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local before importing anything that reads process.env
const envPath = resolve(process.cwd(), ".env.local");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local may not exist in all environments — continue with existing env
}

import postgres from "postgres";

const db_url = process.env.DATABASE_URL;
if (!db_url) throw new Error("DATABASE_URL is not set");

const sql = postgres(db_url, { max: 1 });

type CollisionRow = {
  institution_id: string;
  slug: string;
  institution_type: string | null;
  created_at: Date;
  colliding_username: string;
  colliding_user_id: string;
};

async function main() {
  // Join on the normalized equality: the username's slug form (`_`→`-`, lowercased) equals the
  // institution's already-normalized slug. This is the same comparison the runtime guard makes.
  const rows = (await sql`
    SELECT
      i.id            AS institution_id,
      i.slug          AS slug,
      i.institution_type AS institution_type,
      i.created_at    AS created_at,
      u.username      AS colliding_username,
      u.id            AS colliding_user_id
    FROM institutions i
    JOIN users u
      ON replace(lower(u.username), '_', '-') = i.slug
    WHERE i.institution_type IS DISTINCT FROM 'personal'
    ORDER BY i.created_at ASC
  `) as unknown as CollisionRow[];

  if (rows.length === 0) {
    console.log("Audit clean: no full-institution slug collides with an existing username.");
    await sql.end();
    process.exit(0);
  }

  console.log(`Found ${rows.length} institution-slug / username collision(s):\n`);
  for (const r of rows) {
    console.log(
      [
        `institution_id=${r.institution_id}`,
        `slug=${r.slug}`,
        `type=${r.institution_type ?? "NULL(full)"}`,
        `created_at=${r.created_at.toISOString()}`,
        `colliding_username=${r.colliding_username}`,
        `colliding_user_id=${r.colliding_user_id}`,
      ].join("  "),
    );
  }
  console.log(
    "\nThis audit is read-only. Resolution is operational: platform_ops decides per row whether to" +
      " leave the slug, rename the institution slug, or have the user rename.",
  );

  await sql.end();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
