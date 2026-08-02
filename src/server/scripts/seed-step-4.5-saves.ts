/**
 * Manual test seed — saved competitions preview cap.
 * Creates 6 published competitions under Universitas Indonesia and saves all 6
 * for nicholasbryan250@gmail.com so the dashboard preview shows exactly 5.
 *
 * Run: npx tsx src/server/scripts/seed-step-4.5-saves.ts
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull } from "drizzle-orm";
import { competitions, competitionSaves, institutions, users } from "../db/schema";

const DB_URL = "postgresql://lombakita_app:LombakitaAppNBT01%21@localhost:5432/lombakita";

const INSTITUTION_SLUG = "universitas-indonesia";
const USER_EMAIL = "nicholasbryan250@gmail.com";

const COMPETITION_SEEDS = [
  { slug: "lomba-desain-ui-2026", title: "Lomba Desain UI 2026" },
  { slug: "kompetisi-data-science-nasional", title: "Kompetisi Data Science Nasional" },
  { slug: "hackathon-energi-terbarukan", title: "Hackathon Energi Terbarukan" },
  { slug: "olimpiade-matematika-mahasiswa", title: "Olimpiade Matematika Mahasiswa" },
  { slug: "business-plan-competition-2026", title: "Business Plan Competition 2026" },
  { slug: "lomba-karya-tulis-ilmiah-2026", title: "Lomba Karya Tulis Ilmiah 2026" },
];

const REG_START = new Date("2026-06-01T00:00:00.000Z");
const REG_END = new Date("2026-12-01T00:00:00.000Z");
const EVENT_START = new Date("2027-01-15T00:00:00.000Z");
const EVENT_END = new Date("2027-01-16T00:00:00.000Z");

async function seed() {
  const sql = postgres(DB_URL, { max: 1 });
  const db = drizzle(sql);

  // 1. Resolve institution
  const [institution] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(eq(institutions.slug, INSTITUTION_SLUG))
    .limit(1);

  if (!institution) {
    throw new Error(`Institution '${INSTITUTION_SLUG}' not found`);
  }
  console.log(`Institution: ${INSTITUTION_SLUG} (${institution.id})`);

  // 2. Resolve user
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, USER_EMAIL))
    .limit(1);

  if (!user) {
    throw new Error(`User '${USER_EMAIL}' not found`);
  }
  console.log(`User: ${USER_EMAIL} (${user.id})`);

  // 3. Upsert 6 published competitions (skip if slug already exists under this institution)
  const competitionIds: string[] = [];

  for (const seed of COMPETITION_SEEDS) {
    const existing = await db
      .select({ id: competitions.id })
      .from(competitions)
      .where(
        and(
          eq(competitions.institutionId, institution.id),
          eq(competitions.slug, seed.slug),
          isNull(competitions.deletedAt),
        ),
      )
      .limit(1);

    if (existing[0]) {
      console.log(`  ↳ Exists: ${seed.slug} (${existing[0].id})`);
      competitionIds.push(existing[0].id);
      continue;
    }

    const [inserted] = await db
      .insert(competitions)
      .values({
        institutionId: institution.id,
        slug: seed.slug,
        title: seed.title,
        description: `Seed competition for the saved-preview manual test — ${seed.title}`,
        status: "published",
        mode: "individual",
        category: "hackathon",
        registrationStartAt: REG_START,
        registrationEndAt: REG_END,
        eventStartAt: EVENT_START,
        eventEndAt: EVENT_END,
        publishedAt: new Date(),
      })
      .returning({ id: competitions.id });

    if (!inserted) throw new Error(`Failed to insert competition ${seed.slug}`);
    console.log(`  ↳ Created: ${seed.slug} (${inserted.id})`);
    competitionIds.push(inserted.id);
  }

  // 4. Save all 6 for the user (idempotent — onConflictDoNothing)
  let newSaves = 0;
  for (const competitionId of competitionIds) {
    const result = await db
      .insert(competitionSaves)
      .values({ userId: user.id, competitionId })
      .onConflictDoNothing()
      .returning({ competitionId: competitionSaves.competitionId });

    if (result.length > 0) newSaves++;
  }

  // 5. Report final state
  const totalSaves = await db
    .select({ competitionId: competitionSaves.competitionId })
    .from(competitionSaves)
    .where(eq(competitionSaves.userId, user.id));

  console.log(`\nDone. New saves inserted: ${newSaves}`);
  console.log(`Total saves for ${USER_EMAIL}: ${totalSaves.length}`);
  console.log(`\nExpected dashboard behaviour:`);
  console.log(`  Preview shows: 5 items (capped)`);
  console.log(`  "Lihat semua" link → /saved (shows all ${totalSaves.length})`);

  await sql.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
