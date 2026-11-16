/**
 * Seeds a mock verified institution and three featured, published competitions (featured order 2
 * to 4) so the homepage "Kompetisi unggulan" row shows four with the matrix seed's featured
 * competition (featured order 1). Run it AFTER `scripts/seed-test-matrix.ts`.
 *
 * Idempotent: fixed ids, ON CONFLICT DO UPDATE. Safe to re-run. Refuses any database that is not
 * a disposable local one.
 *
 * Usage: node --import tsx scripts/seed-featured-competitions.ts
 */
import { assertSeedTargetIsDisposable, resolveSeedDatabaseUrl } from "./seed/seed-target";

const databaseUrl = resolveSeedDatabaseUrl(
  "This script writes a mock institution and featured competitions that are fixture data only " +
    "on a disposable local database.",
);

const INSTITUTION_ID = "seed-inst-juara-nusantara";
const INSTITUTION_SLUG = "juara-nusantara";
const INSTITUTION_NAME = "Yayasan Juara Nusantara";

// A database seeded by an older run may still feature this competition, which would put a fifth
// card in the row.
const RETIRED_FEATURED_COMPETITION_ID = "seed-comp-business-case";

const DAY = 24 * 60 * 60 * 1000;

type Seed = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  mode: "individual" | "team" | "both";
  location: "online" | "offline" | "hybrid";
  audience: string[];
  minTeamSize: number | null;
  maxTeamSize: number | null;
  registrationEndInDays: number;
  eventStartInDays: number;
  featuredOrder: number;
};

const COMPETITIONS: Seed[] = [
  {
    id: "seed-comp-garuda-hack",
    slug: "garuda-hack-2026",
    title: "Garuda Hack 2026",
    description:
      "Hackathon nasional 48 jam untuk membangun solusi digital yang berdampak bagi masyarakat Indonesia. Terbuka untuk tim lintas kampus.",
    category: "hackathon",
    mode: "team",
    location: "hybrid",
    audience: ["mahasiswa"],
    minTeamSize: 2,
    maxTeamSize: 4,
    registrationEndInDays: 30,
    eventStartInDays: 45,
    featuredOrder: 2,
  },
  {
    id: "seed-comp-olimpiade-sains",
    slug: "olimpiade-sains-nasional-2026",
    title: "Olimpiade Sains Nasional 2026",
    description:
      "Ajang bergengsi bagi mahasiswa untuk menguji kemampuan di bidang matematika, fisika, dan kimia dengan soal-soal tingkat lanjut.",
    category: "scientific_writing",
    mode: "individual",
    location: "online",
    audience: ["sma_smk", "smp"],
    minTeamSize: null,
    maxTeamSize: null,
    registrationEndInDays: 12,
    eventStartInDays: 28,
    featuredOrder: 3,
  },
  {
    id: "seed-comp-desain-nusantara",
    slug: "festival-desain-nusantara-2026",
    title: "Festival Desain Nusantara",
    description:
      "Kompetisi desain visual dan UI/UX yang mengangkat kekayaan budaya Nusantara. Tunjukkan karya terbaikmu dan menangkan hadiah jutaan rupiah.",
    category: "design",
    mode: "both",
    location: "offline",
    audience: ["umum"],
    minTeamSize: 1,
    maxTeamSize: 3,
    registrationEndInDays: 25,
    eventStartInDays: 50,
    featuredOrder: 4,
  },
];

const main = async (): Promise<void> => {
  const { default: postgres } = await import("postgres");
  const client = postgres(databaseUrl, { max: 1, prepare: false });

  try {
    await assertSeedTargetIsDisposable(client, databaseUrl);

    await client`
      INSERT INTO institutions (
        id, display_name, slug, status, institution_type, verification_status, verified_at
      ) VALUES (
        ${INSTITUTION_ID}, ${INSTITUTION_NAME}, ${INSTITUTION_SLUG}, 'active', 'foundation', 'verified', now()
      )
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        slug = EXCLUDED.slug,
        verification_status = 'verified',
        verified_at = now(),
        updated_at = now()
    `;

    for (const c of COMPETITIONS) {
      const registrationEndAt = new Date(Date.now() + c.registrationEndInDays * DAY);
      const eventStartAt = new Date(Date.now() + c.eventStartInDays * DAY);
      const eventEndAt = new Date(Date.now() + (c.eventStartInDays + 2) * DAY);

      const audienceLiteral = `{${c.audience.join(",")}}`;

      await client`
        INSERT INTO competitions (
          id, institution_id, slug, title, description, status, category, mode,
          location, audience, min_team_size, max_team_size,
          registration_start_at, registration_end_at, event_start_at, event_end_at,
          is_featured, featured_order, published_at
        ) VALUES (
          ${c.id}, ${INSTITUTION_ID}, ${c.slug}, ${c.title}, ${c.description}, 'published',
          ${c.category}, ${c.mode}, ${c.location}, ${audienceLiteral}::competition_audience[],
          ${c.minTeamSize}, ${c.maxTeamSize},
          now(), ${registrationEndAt}, ${eventStartAt}, ${eventEndAt},
          true, ${c.featuredOrder}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          status = 'published',
          category = EXCLUDED.category,
          mode = EXCLUDED.mode,
          location = EXCLUDED.location,
          audience = EXCLUDED.audience,
          min_team_size = EXCLUDED.min_team_size,
          max_team_size = EXCLUDED.max_team_size,
          registration_end_at = EXCLUDED.registration_end_at,
          event_start_at = EXCLUDED.event_start_at,
          event_end_at = EXCLUDED.event_end_at,
          is_featured = true,
          featured_order = EXCLUDED.featured_order,
          published_at = now(),
          updated_at = now()
      `;
    }

    await client`
      UPDATE competitions
      SET is_featured = false, featured_order = NULL, updated_at = now()
      WHERE id = ${RETIRED_FEATURED_COMPETITION_ID}
    `;

    const rows = await client<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM competitions
      WHERE is_featured = true AND status = 'published' AND deleted_at IS NULL
    `;
    console.log(`Seeded. Featured published competitions now: ${rows[0]?.count ?? 0}`);
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
