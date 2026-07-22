/**
 * Seeds a mock verified institution and a handful of featured, published competitions so the
 * homepage "Kompetisi ternama" section (which queries is_featured) has content to render.
 *
 * Idempotent: fixed ids, ON CONFLICT DO UPDATE. Safe to re-run.
 *
 * Usage: node --import tsx scripts/seed-featured-competitions.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

try {
  for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
} catch {
  // .env.local optional; rely on ambient env
}
process.env.APP_ENV = "test";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const INSTITUTION_ID = "seed-inst-juara-nusantara";
const INSTITUTION_SLUG = "juara-nusantara";
const INSTITUTION_NAME = "Yayasan Juara Nusantara";

const DAY = 24 * 60 * 60 * 1000;

type Seed = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  mode: "individual" | "team" | "both";
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
    category: "technology",
    mode: "team",
    minTeamSize: 2,
    maxTeamSize: 4,
    registrationEndInDays: 30,
    eventStartInDays: 45,
    featuredOrder: 1,
  },
  {
    id: "seed-comp-business-case",
    slug: "national-business-case-2026",
    title: "National Business Case Competition",
    description:
      "Kompetisi studi kasus bisnis tingkat nasional. Analisis masalah nyata dari mitra industri dan presentasikan strategi terbaikmu di depan dewan juri.",
    category: "business",
    mode: "team",
    minTeamSize: 3,
    maxTeamSize: 5,
    registrationEndInDays: 20,
    eventStartInDays: 40,
    featuredOrder: 2,
  },
  {
    id: "seed-comp-olimpiade-sains",
    slug: "olimpiade-sains-nasional-2026",
    title: "Olimpiade Sains Nasional 2026",
    description:
      "Ajang bergengsi bagi mahasiswa untuk menguji kemampuan di bidang matematika, fisika, dan kimia dengan soal-soal tingkat lanjut.",
    category: "science",
    mode: "individual",
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
    category: "creative_arts",
    mode: "both",
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
    await client`
      INSERT INTO institutions (
        id, display_name, slug, status, institution_type, verification_status, verified_at
      ) VALUES (
        ${INSTITUTION_ID}, ${INSTITUTION_NAME}, ${INSTITUTION_SLUG}, 'active', NULL, 'verified', now()
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

      await client`
        INSERT INTO competitions (
          id, institution_id, slug, title, description, status, category, mode,
          min_team_size, max_team_size,
          registration_start_at, registration_end_at, event_start_at, event_end_at,
          is_featured, featured_order, published_at
        ) VALUES (
          ${c.id}, ${INSTITUTION_ID}, ${c.slug}, ${c.title}, ${c.description}, 'published',
          ${c.category}, ${c.mode}, ${c.minTeamSize}, ${c.maxTeamSize},
          now(), ${registrationEndAt}, ${eventStartAt}, ${eventEndAt},
          true, ${c.featuredOrder}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          status = 'published',
          category = EXCLUDED.category,
          mode = EXCLUDED.mode,
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
