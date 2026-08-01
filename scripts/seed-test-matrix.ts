/**
 * Seeds the full-stack testing matrix: accounts in every role/state, institutions in every
 * type/status, competitions across every derived lifecycle phase, registrations (individual,
 * team, cancelled), submissions, results (draft/published), document requests in every status,
 * verification submissions in every status, invitations, notifications, saves, and reviews.
 *
 * Idempotent and additive: every row uses a fixed `seed-` prefixed id with ON CONFLICT
 * DO UPDATE, so re-running refreshes relative dates (competition phases stay correct over
 * days) and resets seed rows to canonical states. Non-seed rows are never touched.
 *
 * All seeded accounts share the password: UjiCoba123!
 *
 * Usage: node --import tsx scripts/seed-test-matrix.ts
 */
import { createHash, scrypt } from "crypto";
import { promisify } from "util";
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const scryptAsync = promisify(scrypt);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Date.now();
const d = (days: number): Date => new Date(now + days * DAY);
const h = (hours: number): Date => new Date(now + hours * HOUR);

const PASSWORD = "UjiCoba123!";
// Deterministic salt (valid hex, 16 bytes) so re-runs produce the identical hash.
const SEED_SALT = "5eed5a175eed5a175eed5a175eed5a17";

// Mirrors src/server/auth/password.ts: `s1$<salt hex>$<scrypt-64 hex>`.
const hashSeedPassword = async (): Promise<string> => {
  const derived = (await scryptAsync(PASSWORD, SEED_SALT, 64)) as Buffer;
  return `s1$${SEED_SALT}$${derived.toString("hex")}`;
};

const sha256 = (raw: string): string => createHash("sha256").update(raw).digest("hex");

const EMAIL = (local: string): string => `${local}@seed.lombakita.local`;

const main = async (): Promise<void> => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const passwordHash = await hashSeedPassword();

  try {
    // ---------------------------------------------------------------- users
    type UserSeed = {
      id: string;
      name: string;
      email: string;
      emailVerified: Date | null;
      role: string;
      username: string;
      candAt: Date | null;
      recAt: Date | null;
      tier: string;
      suspendedAt: Date | null;
      suspensionReason: string | null;
    };
    const users: UserSeed[] = [
      { id: "seed-user-cand-a", name: "Andi Saputra", email: EMAIL("seed.cand.a"), emailVerified: d(-60), role: "candidate", username: "seed_cand_a", candAt: d(-60), recAt: null, tier: "unverified", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-cand-b", name: "Bela Rahma", email: EMAIL("seed.cand.b"), emailVerified: d(-55), role: "candidate", username: "seed_cand_b", candAt: d(-55), recAt: null, tier: "unverified", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-cand-c", name: "Citra Dewi", email: EMAIL("seed.cand.c"), emailVerified: d(-50), role: "candidate", username: "seed_cand_c", candAt: d(-50), recAt: null, tier: "unverified", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-rec-min", name: "Rina Wijaya", email: EMAIL("seed.rec.min"), emailVerified: d(-30), role: "recruiter", username: "seed_rec_min", candAt: null, recAt: d(-30), tier: "minimal", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-rec-elev", name: "Eko Prasetyo", email: EMAIL("seed.rec.elev"), emailVerified: d(-90), role: "recruiter", username: "seed_rec_elev", candAt: null, recAt: d(-90), tier: "elevated", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-rec-rej", name: "Raka Nugraha", email: EMAIL("seed.rec.rej"), emailVerified: d(-20), role: "recruiter", username: "seed_rec_rej", candAt: null, recAt: d(-20), tier: "minimal", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-rec-draft", name: "Dodi Firmansyah", email: EMAIL("seed.rec.draft"), emailVerified: d(-15), role: "recruiter", username: "seed_rec_draft", candAt: null, recAt: d(-15), tier: "minimal", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-dual", name: "Dina Kusuma", email: EMAIL("seed.dual"), emailVerified: d(-45), role: "candidate", username: "seed_dual", candAt: d(-45), recAt: d(-25), tier: "minimal", suspendedAt: null, suspensionReason: null },
      // Operational account: candidate_verified_at is the users_one_verified_role_chk
      // satisfier only (migration-0015 carve-out) — deliberately NO candidate_profiles row.
      { id: "seed-user-ops", name: "Ops Seed", email: EMAIL("seed.ops"), emailVerified: d(-100), role: "platform_ops", username: "seed_ops", candAt: d(-100), recAt: null, tier: "unverified", suspendedAt: null, suspensionReason: null },
      { id: "seed-user-susp", name: "Sari Utami", email: EMAIL("seed.susp"), emailVerified: d(-40), role: "candidate", username: "seed_susp", candAt: d(-40), recAt: null, tier: "unverified", suspendedAt: d(-1), suspensionReason: "Pelanggaran ketentuan (data uji)" },
      { id: "seed-user-unver", name: "Udin Baru", email: EMAIL("seed.unver"), emailVerified: null, role: "candidate", username: "seed_unver", candAt: d(-1), recAt: null, tier: "unverified", suspendedAt: null, suspensionReason: null },
    ];

    for (const u of users) {
      await sql`
        INSERT INTO users (id, name, email, email_verified, role, username,
          candidate_verified_at, recruiter_verified_at, recruiter_verification_tier,
          suspended_at, suspension_reason)
        VALUES (${u.id}, ${u.name}, ${u.email}, ${u.emailVerified}, ${u.role}, ${u.username},
          ${u.candAt}, ${u.recAt}, ${u.tier}, ${u.suspendedAt}, ${u.suspensionReason})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
          role = EXCLUDED.role, username = EXCLUDED.username,
          candidate_verified_at = EXCLUDED.candidate_verified_at,
          recruiter_verified_at = EXCLUDED.recruiter_verified_at,
          recruiter_verification_tier = EXCLUDED.recruiter_verification_tier,
          suspended_at = EXCLUDED.suspended_at, suspension_reason = EXCLUDED.suspension_reason,
          updated_at = now()
      `;
      await sql`
        INSERT INTO user_password_credentials (user_id, password_hash)
        VALUES (${u.id}, ${passwordHash})
        ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
      `;
      await sql`
        INSERT INTO user_profiles (user_id, display_name, summary, location)
        VALUES (${u.id}, ${u.name}, ${"Akun data uji (seed)."}, ${"Jakarta, Indonesia"})
        ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
      `;
    }

    // Candidate onboarding profiles (every candidate-verified account EXCEPT the ops carve-out).
    const candidateProfiles = [
      { userId: "seed-user-cand-a", fullName: "Andi Saputra", phone: "+6281200000001", occupation: "college_student", dob: "2004-05-14" },
      { userId: "seed-user-cand-b", fullName: "Bela Rahma", phone: "+6281200000002", occupation: "school_student", dob: "2008-11-02" },
      { userId: "seed-user-cand-c", fullName: "Citra Dewi", phone: "+6281200000003", occupation: "professional", dob: "1998-03-27" },
      { userId: "seed-user-dual", fullName: "Dina Kusuma", phone: "+6281200000004", occupation: "college_student", dob: "2003-08-19" },
      { userId: "seed-user-susp", fullName: "Sari Utami", phone: "+6281200000005", occupation: "new_graduate", dob: "2001-01-09" },
      { userId: "seed-user-unver", fullName: "Udin Baru", phone: "+6281200000006", occupation: "other", dob: "2005-06-30" },
    ];
    for (const p of candidateProfiles) {
      await sql`
        INSERT INTO candidate_profiles (user_id, full_name, phone_number, occupation, date_of_birth)
        VALUES (${p.userId}, ${p.fullName}, ${p.phone}, ${p.occupation}, ${p.dob})
        ON CONFLICT (user_id) DO UPDATE SET
          full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number,
          occupation = EXCLUDED.occupation, date_of_birth = EXCLUDED.date_of_birth,
          updated_at = now()
      `;
    }

    // --------------------------------------------------------- institutions
    type InstSeed = {
      id: string; displayName: string | null; slug: string; type: string;
      verification: string; verifiedAt: Date | null;
      suspendedAt: Date | null; suspensionReason: string | null;
      description: string | null; about: string | null;
      contactName: string | null; contactEmail: string | null; contactPhone: string | null;
      websiteUrl: string | null;
    };
    const institutions: InstSeed[] = [
      {
        id: "seed-inst-a", displayName: "Seed Academy", slug: "seed-academy", type: "university",
        verification: "verified", verifiedAt: d(-30), suspendedAt: null, suspensionReason: null,
        description: "Universitas penyelenggara kompetisi data uji.",
        about: "Seed Academy adalah universitas fiktif untuk pengujian menyeluruh Lombakita. Kami menyelenggarakan kompetisi lintas bidang sepanjang tahun.",
        contactName: "Panitia Seed Academy", contactEmail: EMAIL("panitia.seed.academy"),
        contactPhone: "+62215550101", websiteUrl: "https://seed-academy.example",
      },
      {
        id: "seed-inst-b", displayName: "Seed Ventures", slug: "seed-ventures", type: "company",
        verification: "pending_verification", verifiedAt: null, suspendedAt: null, suspensionReason: null,
        description: "Perusahaan data uji — menunggu verifikasi dokumen.",
        about: null, contactName: null, contactEmail: null, contactPhone: null, websiteUrl: null,
      },
      {
        id: "seed-inst-c", displayName: "Seed Suspended Org", slug: "seed-suspended-org", type: "company",
        verification: "verified", verifiedAt: d(-40), suspendedAt: d(-2),
        suspensionReason: "Penangguhan operasional (data uji)",
        description: "Organisasi data uji dalam keadaan ditangguhkan.",
        about: null, contactName: null, contactEmail: null, contactPhone: null, websiteUrl: null,
      },
      {
        // Personal institution: display_name NULL (derived from owner), slug tracks owner username.
        id: "seed-inst-p", displayName: null, slug: "seed-rec-min", type: "personal",
        verification: "pending_verification", verifiedAt: null, suspendedAt: null, suspensionReason: null,
        description: "Institusi personal milik Rina (data uji).",
        about: null, contactName: null, contactEmail: null, contactPhone: null, websiteUrl: null,
      },
    ];
    for (const i of institutions) {
      await sql`
        INSERT INTO institutions (id, display_name, slug, status, institution_type, description,
          verification_status, verified_at, suspended_at, suspension_reason,
          about, contact_name, contact_email, contact_phone, website_url)
        VALUES (${i.id}, ${i.displayName}, ${i.slug}, 'active', ${i.type}, ${i.description},
          ${i.verification}, ${i.verifiedAt}, ${i.suspendedAt}, ${i.suspensionReason},
          ${i.about}, ${i.contactName}, ${i.contactEmail}, ${i.contactPhone}, ${i.websiteUrl})
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name, slug = EXCLUDED.slug,
          institution_type = EXCLUDED.institution_type, description = EXCLUDED.description,
          verification_status = EXCLUDED.verification_status, verified_at = EXCLUDED.verified_at,
          suspended_at = EXCLUDED.suspended_at, suspension_reason = EXCLUDED.suspension_reason,
          about = EXCLUDED.about, contact_name = EXCLUDED.contact_name,
          contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone,
          website_url = EXCLUDED.website_url, updated_at = now()
      `;
    }

    const memberships = [
      { id: "seed-mem-a-owner", inst: "seed-inst-a", user: "seed-user-rec-elev", role: "institution_owner" },
      { id: "seed-mem-a-staff", inst: "seed-inst-a", user: "seed-user-dual", role: "institution_staff" },
      { id: "seed-mem-b-owner", inst: "seed-inst-b", user: "seed-user-rec-elev", role: "institution_owner" },
      { id: "seed-mem-c-owner", inst: "seed-inst-c", user: "seed-user-rec-elev", role: "institution_owner" },
      { id: "seed-mem-p-owner", inst: "seed-inst-p", user: "seed-user-rec-min", role: "institution_owner" },
    ];
    for (const m of memberships) {
      await sql`
        INSERT INTO institution_memberships (id, institution_id, user_id, membership_role, status)
        VALUES (${m.id}, ${m.inst}, ${m.user}, ${m.role}, 'active')
        ON CONFLICT (institution_id, user_id) DO UPDATE SET
          membership_role = EXCLUDED.membership_role, status = 'active', updated_at = now()
      `;
    }

    const socialLinks = [
      { id: "seed-soc-a-ig", inst: "seed-inst-a", platform: "instagram", url: "https://instagram.com/seedacademy" },
      { id: "seed-soc-a-web", inst: "seed-inst-a", platform: "website", url: "https://seed-academy.example" },
    ];
    for (const s of socialLinks) {
      await sql`
        INSERT INTO institution_social_links (id, institution_id, platform, url)
        VALUES (${s.id}, ${s.inst}, ${s.platform}, ${s.url})
        ON CONFLICT (institution_id, platform) DO UPDATE SET url = EXCLUDED.url, updated_at = now()
      `;
    }

    // --------------------------------------------------------- competitions
    type CompSeed = {
      id: string; inst: string; createdBy: string; slug: string; title: string;
      description: string; status: "draft" | "published"; category: string | null;
      mode: string | null; minTeam: number | null; maxTeam: number | null;
      rs: Date | null; re: Date | null; es: Date | null; ee: Date | null; ra: Date | null;
      allowCancel: boolean; cutoffDays: number | null; eligibilityNote: string | null;
      featured: boolean; featuredOrder: number | null; publishedAt: Date | null;
      // Minimum-entry commitment. `pca` (participant confirmation) is publish-required and must
      // satisfy registration_end_at <= pca < event_start_at; when omitted it is derived as the
      // midpoint of that window.
      minEntries?: number | null; pca?: Date | null;
    };
    const comps: CompSeed[] = [
      {
        id: "seed-comp-draft", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-draft", title: "Seed Draft Competition",
        description: "Draf kompetisi data uji — belum lengkap, target halaman edit.",
        status: "draft", category: "other", mode: null, minTeam: null, maxTeam: null,
        rs: null, re: null, es: null, ee: null, ra: null,
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: null,
      },
      {
        id: "seed-comp-upcoming", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-upcoming", title: "Olimpiade Seed Nasional",
        description: "Pendaftaran belum dibuka — fase 'upcoming'. Uji CTA 'belum dibuka'.",
        status: "published", category: "olympiad", mode: "both", minTeam: 2, maxTeam: 3,
        rs: d(5), re: d(30), es: d(45), ee: d(47), ra: d(54),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-3),
      },
      {
        id: "seed-comp-open", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-open", title: "Seed Hackathon Nusantara",
        description: "Kompetisi unggulan data uji: pendaftaran dibuka, mode individu & tim, hadiah, babak, dan tag lengkap.",
        status: "published", category: "hackathon", mode: "both", minTeam: 2, maxTeam: 4,
        rs: d(-2), re: d(21), es: d(30), ee: d(32), ra: d(40),
        allowCancel: true, cutoffDays: 3,
        eligibilityNote: "Diutamakan untuk siswa SMA/SMK — panitia dapat meminta dokumen bukti status.",
        featured: false, featuredOrder: null, publishedAt: d(-2),
      },
      {
        id: "seed-comp-featured", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-featured", title: "Seed Business Case Challenge",
        description: "Kompetisi unggulan (featured #1). Pembatalan mandiri TIDAK diizinkan.",
        status: "published", category: "business", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-1), re: d(14), es: d(20), ee: d(21), ra: d(28),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: true, featuredOrder: 1, publishedAt: d(-1),
      },
      {
        id: "seed-comp-closing", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-closing", title: "Seed Design Sprint",
        description: "Pendaftaran segera ditutup (badge 'segera ditutup'). Mode tim.",
        status: "published", category: "design", mode: "team", minTeam: 2, maxTeam: 4,
        rs: d(-10), re: d(3), es: d(12), ee: d(13), ra: d(20),
        allowCancel: true, cutoffDays: 2, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-10),
      },
      {
        // Team-capable, registration open, and deliberately EMPTY of registrations. Every other
        // team-mode competition already has both free candidates registered, so the team lifecycle
        // (create → invite → accept → register → cancel → delete) has nowhere else to run. Keep it
        // unregistered: the assertions restore what they create, and a seeded registrant here
        // would put the captain slot permanently out of reach.
        id: "seed-comp-teamopen", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-team-open", title: "Seed Team Relay",
        description: "Kompetisi mode tim dengan pendaftaran terbuka — panggung uji siklus tim.",
        status: "published", category: "programming", mode: "team", minTeam: 2, maxTeam: 4,
        rs: d(-4), re: d(25), es: d(35), ee: d(36), ra: d(43),
        allowCancel: true, cutoffDays: 3, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-4),
      },
      {
        id: "seed-comp-closed", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-closed", title: "Seed Essay Marathon",
        description: "Pendaftaran sudah ditutup, acara belum mulai. Uji CTA 'ditutup' dan penolakan daftar.",
        status: "published", category: "essay", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-30), re: d(-7), es: d(7), ee: d(8), ra: d(15),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-30),
        // Minimum-entry commitment already lapsed with zero entries — the organizer's
        // participation-decision surface is live on this competition.
        minEntries: 25, pca: d(-1),
      },
      {
        id: "seed-comp-inprogress", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-inprogress", title: "Seed Coding League",
        description: "Acara sedang berlangsung (fase 'in progress').",
        status: "published", category: "programming", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-30), re: d(-10), es: d(-2), ee: d(2), ra: d(9),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-30),
      },
      {
        id: "seed-comp-awaiting", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-awaiting", title: "Seed Data Science Cup",
        description: "Acara selesai, menunggu pengumuman hasil (batas +4 hari).",
        status: "published", category: "data_science", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-40), re: d(-20), es: d(-5), ee: d(-3), ra: d(4),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-40),
      },
      {
        id: "seed-comp-overdue", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-overdue", title: "Seed Debate Open",
        description: "Hasil melewati tanggal pengumuman + masa tenggang (fase 'terlambat').",
        status: "published", category: "debate", mode: "team", minTeam: 2, maxTeam: 3,
        rs: d(-60), re: d(-45), es: d(-32), ee: d(-30), ra: d(-20),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-60),
      },
      {
        id: "seed-comp-done", inst: "seed-inst-a", createdBy: "seed-user-rec-elev",
        slug: "seed-done", title: "Seed Scientific Writing Festival",
        description: "Kompetisi selesai dengan hasil terpublikasi — arsip publik tetap terbuka.",
        status: "published", category: "scientific_writing", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-60), re: d(-40), es: d(-25), ee: d(-20), ra: d(-14),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-60),
      },
      {
        id: "seed-comp-personal-open", inst: "seed-inst-p", createdBy: "seed-user-rec-min",
        slug: "seed-personal-open", title: "Kuis Mingguan Rina",
        description: "Kompetisi di bawah institusi personal (nama & media diturunkan dari pemilik).",
        status: "published", category: "quiz", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-1), re: d(20), es: d(25), ee: d(26), ra: d(33),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-1),
      },
      {
        id: "seed-comp-personal-draft", inst: "seed-inst-p", createdBy: "seed-user-rec-min",
        slug: "seed-personal-draft", title: "Kuis Spesial Rina (Draf)",
        description: "Draf lengkap siap terbit — uji otomatis: publish HARUS ditolak (tier minimal).",
        status: "draft", category: "quiz", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(1), re: d(20), es: d(25), ee: d(26), ra: d(33),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: null,
      },
      {
        id: "seed-comp-susp", inst: "seed-inst-c", createdBy: "seed-user-rec-elev",
        slug: "seed-susp-open", title: "Seed Marketing Battle",
        description: "Kompetisi milik organisasi yang ditangguhkan — uji perilaku keterjangkauan publik.",
        status: "published", category: "marketing", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(-5), re: d(15), es: d(20), ee: d(21), ra: d(28),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: d(-5),
      },
      {
        id: "seed-comp-b-draft", inst: "seed-inst-b", createdBy: "seed-user-rec-elev",
        slug: "seed-b-draft", title: "Seed Ventures Fintech Days",
        description: "Draf lengkap di bawah Seed Ventures — target IDOR lintas-tenant dan alur publish.",
        status: "draft", category: "finance", mode: "individual", minTeam: null, maxTeam: null,
        rs: d(2), re: d(25), es: d(30), ee: d(31), ra: d(38),
        allowCancel: false, cutoffDays: null, eligibilityNote: null,
        featured: false, featuredOrder: null, publishedAt: null,
      },
    ];
    for (const c of comps) {
      const pca =
        c.pca !== undefined
          ? c.pca
          : c.re && c.es
            ? new Date(c.re.getTime() + (c.es.getTime() - c.re.getTime()) / 2)
            : null;
      const minEntries = c.minEntries ?? null;
      await sql`
        INSERT INTO competitions (id, institution_id, created_by_user_id, slug, title, description,
          status, category, mode, min_team_size, max_team_size,
          registration_start_at, registration_end_at, event_start_at, event_end_at,
          result_announcement_at, minimum_participant_entries, participant_confirmation_at,
          allow_cancellation, cancellation_cutoff_days,
          eligibility_note, is_featured, featured_order, published_at)
        VALUES (${c.id}, ${c.inst}, ${c.createdBy}, ${c.slug}, ${c.title}, ${c.description},
          ${c.status}, ${c.category}, ${c.mode}, ${c.minTeam}, ${c.maxTeam},
          ${c.rs}, ${c.re}, ${c.es}, ${c.ee},
          ${c.ra}, ${minEntries}, ${pca}, ${c.allowCancel}, ${c.cutoffDays},
          ${c.eligibilityNote}, ${c.featured}, ${c.featuredOrder}, ${c.publishedAt})
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug, title = EXCLUDED.title, description = EXCLUDED.description,
          status = EXCLUDED.status, category = EXCLUDED.category, mode = EXCLUDED.mode,
          min_team_size = EXCLUDED.min_team_size, max_team_size = EXCLUDED.max_team_size,
          registration_start_at = EXCLUDED.registration_start_at,
          registration_end_at = EXCLUDED.registration_end_at,
          event_start_at = EXCLUDED.event_start_at, event_end_at = EXCLUDED.event_end_at,
          result_announcement_at = EXCLUDED.result_announcement_at,
          minimum_participant_entries = EXCLUDED.minimum_participant_entries,
          participant_confirmation_at = EXCLUDED.participant_confirmation_at,
          allow_cancellation = EXCLUDED.allow_cancellation,
          cancellation_cutoff_days = EXCLUDED.cancellation_cutoff_days,
          eligibility_note = EXCLUDED.eligibility_note,
          is_featured = EXCLUDED.is_featured, featured_order = EXCLUDED.featured_order,
          published_at = EXCLUDED.published_at, deleted_at = NULL, updated_at = now()
      `;
    }

    // Flagship extras: prizes, rounds, tags.
    const prizes = [
      { id: "seed-prize-1", comp: "seed-comp-open", order: 0, rank: "Juara 1", title: "Uang tunai + sertifikat", desc: "Hadiah utama.", cash: "5000000", cert: true },
      { id: "seed-prize-2", comp: "seed-comp-open", order: 1, rank: "Juara 2", title: "Uang tunai", desc: null, cash: "3000000", cert: false },
      { id: "seed-prize-3", comp: "seed-comp-open", order: 2, rank: "Juara 3", title: "Sertifikat", desc: null, cash: null, cert: true },
    ];
    for (const p of prizes) {
      await sql`
        INSERT INTO competition_prizes (id, competition_id, sort_order, rank_label, title, description, cash_amount, is_certificate)
        VALUES (${p.id}, ${p.comp}, ${p.order}, ${p.rank}, ${p.title}, ${p.desc}, ${p.cash}, ${p.cert})
        ON CONFLICT (id) DO UPDATE SET
          sort_order = EXCLUDED.sort_order, rank_label = EXCLUDED.rank_label, title = EXCLUDED.title,
          description = EXCLUDED.description, cash_amount = EXCLUDED.cash_amount,
          is_certificate = EXCLUDED.is_certificate, updated_at = now()
      `;
    }
    const rounds = [
      { id: "seed-round-1", comp: "seed-comp-open", order: 0, title: "Babak Penyisihan", desc: "Seleksi proposal daring.", starts: d(22), ends: d(25), platform: "Online" },
      { id: "seed-round-2", comp: "seed-comp-open", order: 1, title: "Babak Final", desc: "Presentasi final di Jakarta.", starts: d(30), ends: d(32), platform: "Offline" },
    ];
    for (const r of rounds) {
      await sql`
        INSERT INTO competition_rounds (id, competition_id, sort_order, title, description, starts_at, ends_at, platform_label)
        VALUES (${r.id}, ${r.comp}, ${r.order}, ${r.title}, ${r.desc}, ${r.starts}, ${r.ends}, ${r.platform})
        ON CONFLICT (id) DO UPDATE SET
          sort_order = EXCLUDED.sort_order, title = EXCLUDED.title, description = EXCLUDED.description,
          starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
          platform_label = EXCLUDED.platform_label, updated_at = now()
      `;
    }
    const tags: Array<[string, string]> = [
      ["seed-comp-open", "Hackathon"],
      ["seed-comp-open", "Pemrograman"],
      ["seed-comp-open", "Data & AI"],
      ["seed-comp-done", "Riset"],
      ["seed-comp-done", "Esai"],
    ];
    for (const [comp, tag] of tags) {
      await sql`
        INSERT INTO competition_tags (competition_id, tag) VALUES (${comp}, ${tag})
        ON CONFLICT (competition_id, tag) DO NOTHING
      `;
    }

    // Saves for the /saved page.
    for (const compId of ["seed-comp-open", "seed-comp-upcoming", "seed-comp-done"]) {
      await sql`
        INSERT INTO competition_saves (user_id, competition_id)
        VALUES ('seed-user-cand-a', ${compId})
        ON CONFLICT (user_id, competition_id) DO NOTHING
      `;
    }

    // ---------------------------------------------------------------- teams
    await sql`
      INSERT INTO teams (id, competition_id, name, captain_id, status)
      VALUES ('seed-team-b', 'seed-comp-closing', 'Tim Garuda Seed', 'seed-user-cand-b', 'submitted')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
    `;
    await sql`
      INSERT INTO teams (id, competition_id, name, captain_id, status)
      VALUES ('seed-team-f', 'seed-comp-upcoming', 'Tim Rajawali Seed', 'seed-user-cand-c', 'forming')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
    `;
    const teamMembers = [
      { id: "seed-tm-b-captain", team: "seed-team-b", user: "seed-user-cand-b", role: "captain" },
      { id: "seed-tm-b-member", team: "seed-team-b", user: "seed-user-cand-c", role: "member" },
      { id: "seed-tm-f-captain", team: "seed-team-f", user: "seed-user-cand-c", role: "captain" },
    ];
    for (const tm of teamMembers) {
      await sql`
        INSERT INTO team_memberships (id, team_id, user_id, role, status)
        VALUES (${tm.id}, ${tm.team}, ${tm.user}, ${tm.role}, 'active')
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
      `;
    }
    await sql`
      INSERT INTO team_invitations (id, team_id, invited_email, invited_by_user_id, token_hash,
        status, target_user_id, expires_at)
      VALUES ('seed-teaminv-1', 'seed-team-f', ${EMAIL("seed.cand.a")}, 'seed-user-cand-c',
        ${sha256("seed-team-invite-1")}, 'pending', 'seed-user-cand-a', ${d(7)})
      ON CONFLICT (id) DO UPDATE SET
        status = 'pending', target_user_id = EXCLUDED.target_user_id,
        expires_at = EXCLUDED.expires_at, accepted_at = NULL
    `;

    // -------------------------------------------------------- registrations
    type RegSeed = {
      id: string; comp: string; student: string; team: string | null;
      type: "individual" | "team"; status: "confirmed" | "cancelled";
      registeredAt: Date; cancelledAt: Date | null; cancellationReason: string | null;
      reviewStatus: string; internalNotes: string | null;
    };
    const regs: RegSeed[] = [
      { id: "seed-reg-a-open", comp: "seed-comp-open", student: "seed-user-cand-a", team: null, type: "individual", status: "confirmed", registeredAt: d(-1), cancelledAt: null, cancellationReason: null, reviewStatus: "pending_review", internalNotes: null },
      { id: "seed-reg-c-open", comp: "seed-comp-open", student: "seed-user-cand-c", team: null, type: "individual", status: "confirmed", registeredAt: d(-1), cancelledAt: null, cancellationReason: null, reviewStatus: "pending_review", internalNotes: null },
      { id: "seed-reg-a-feat-cxl", comp: "seed-comp-featured", student: "seed-user-cand-a", team: null, type: "individual", status: "cancelled", registeredAt: d(-1), cancelledAt: h(-12), cancellationReason: "Jadwal bentrok dengan ujian sekolah.", reviewStatus: "pending_review", internalNotes: null },
      { id: "seed-reg-a-inprog", comp: "seed-comp-inprogress", student: "seed-user-cand-a", team: null, type: "individual", status: "confirmed", registeredAt: d(-25), cancelledAt: null, cancellationReason: null, reviewStatus: "under_review", internalNotes: null },
      { id: "seed-reg-a-done", comp: "seed-comp-done", student: "seed-user-cand-a", team: null, type: "individual", status: "confirmed", registeredAt: d(-50), cancelledAt: null, cancellationReason: null, reviewStatus: "shortlisted", internalNotes: "Kandidat kuat — finalis (catatan internal seed)." },
      { id: "seed-reg-b-done", comp: "seed-comp-done", student: "seed-user-cand-b", team: null, type: "individual", status: "confirmed", registeredAt: d(-49), cancelledAt: null, cancellationReason: null, reviewStatus: "under_review", internalNotes: null },
      { id: "seed-reg-tb-b", comp: "seed-comp-closing", student: "seed-user-cand-b", team: "seed-team-b", type: "team", status: "confirmed", registeredAt: d(-5), cancelledAt: null, cancellationReason: null, reviewStatus: "pending_review", internalNotes: null },
      { id: "seed-reg-tb-c", comp: "seed-comp-closing", student: "seed-user-cand-c", team: "seed-team-b", type: "team", status: "confirmed", registeredAt: d(-5), cancelledAt: null, cancellationReason: null, reviewStatus: "pending_review", internalNotes: null },
    ];
    for (const r of regs) {
      await sql`
        INSERT INTO competition_registrations (id, competition_id, student_id, team_id,
          registration_type, status, registered_at, cancelled_at, cancellation_reason,
          internal_review_status, internal_notes)
        VALUES (${r.id}, ${r.comp}, ${r.student}, ${r.team}, ${r.type}, ${r.status},
          ${r.registeredAt}, ${r.cancelledAt}, ${r.cancellationReason},
          ${r.reviewStatus}, ${r.internalNotes})
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, cancelled_at = EXCLUDED.cancelled_at,
          cancellation_reason = EXCLUDED.cancellation_reason,
          internal_review_status = EXCLUDED.internal_review_status,
          internal_notes = EXCLUDED.internal_notes, updated_at = now()
      `;
    }

    // ---------------------------------------------------------- submissions
    const submissions = [
      { id: "seed-sub-a-done", reg: "seed-reg-a-done", by: "seed-user-cand-a", key: "submissions/seed-comp-done/seed-reg-a-done/seed-file-a", name: "karya-andi.pdf", size: 184320, mime: "application/pdf", version: 2, finalizedAt: d(-21) },
      { id: "seed-sub-b-done", reg: "seed-reg-b-done", by: "seed-user-cand-b", key: "submissions/seed-comp-done/seed-reg-b-done/seed-file-b", name: "karya-bela.pdf", size: 92160, mime: "application/pdf", version: 1, finalizedAt: d(-22) },
    ];
    for (const s of submissions) {
      await sql`
        INSERT INTO competition_submissions (id, registration_id, submitted_by_id, file_key,
          file_name, file_size_bytes, file_mime_type, version, finalized_at, submitted_at)
        VALUES (${s.id}, ${s.reg}, ${s.by}, ${s.key}, ${s.name}, ${s.size}, ${s.mime},
          ${s.version}, ${s.finalizedAt}, ${s.finalizedAt})
        ON CONFLICT (registration_id) DO UPDATE SET
          file_key = EXCLUDED.file_key, file_name = EXCLUDED.file_name,
          file_size_bytes = EXCLUDED.file_size_bytes, file_mime_type = EXCLUDED.file_mime_type,
          version = EXCLUDED.version, finalized_at = EXCLUDED.finalized_at, updated_at = now()
      `;
    }

    // -------------------------------------------------------------- results
    await sql`
      INSERT INTO competition_results (id, registration_id, competition_id, result_status,
        result_label, result_notes, published_at)
      VALUES ('seed-res-a-done', 'seed-reg-a-done', 'seed-comp-done', 'published',
        'Juara 1', 'Penampilan luar biasa — selamat!', ${d(-14)})
      ON CONFLICT (registration_id) DO UPDATE SET
        result_status = EXCLUDED.result_status, result_label = EXCLUDED.result_label,
        result_notes = EXCLUDED.result_notes, published_at = EXCLUDED.published_at, updated_at = now()
    `;
    await sql`
      INSERT INTO competition_results (id, registration_id, competition_id, result_status,
        result_label, result_notes, published_at)
      VALUES ('seed-res-b-done', 'seed-reg-b-done', 'seed-comp-done', 'draft',
        'Juara 2', 'Draf internal — belum dipublikasikan.', NULL)
      ON CONFLICT (registration_id) DO UPDATE SET
        result_status = 'draft', result_label = EXCLUDED.result_label,
        result_notes = EXCLUDED.result_notes, published_at = NULL, updated_at = now()
    `;

    // ------------------------------------------------ document requests
    type DocReqSeed = {
      id: string; reg: string; title: string; instructions: string | null; dueAt: Date;
      status: string; requestedBy: string; submittedAt: Date | null;
      reviewedBy: string | null; reviewedAt: Date | null; reviewNote: string | null;
      revisionCount: number;
    };
    const docReqs: DocReqSeed[] = [
      { id: "seed-docreq-active", reg: "seed-reg-a-inprog", title: "Kartu Pelajar / KTM", instructions: "Unggah foto kartu pelajar atau KTM yang masih berlaku.", dueAt: d(5), status: "requested", requestedBy: "seed-user-rec-elev", submittedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: null, revisionCount: 0 },
      { id: "seed-docreq-lapsed", reg: "seed-reg-c-open", title: "Surat Keterangan Siswa", instructions: "Surat keterangan aktif dari sekolah.", dueAt: d(-2), status: "requested", requestedBy: "seed-user-rec-elev", submittedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: null, revisionCount: 0 },
      { id: "seed-docreq-submitted", reg: "seed-reg-tb-b", title: "Kartu Identitas", instructions: null, dueAt: d(2), status: "submitted", requestedBy: "seed-user-rec-elev", submittedAt: h(-3), reviewedBy: null, reviewedAt: null, reviewNote: null, revisionCount: 0 },
      { id: "seed-docreq-accepted", reg: "seed-reg-a-done", title: "Kartu Identitas", instructions: null, dueAt: d(-25), status: "accepted", requestedBy: "seed-user-rec-elev", submittedAt: d(-26), reviewedBy: "seed-user-rec-elev", reviewedAt: d(-24), reviewNote: null, revisionCount: 0 },
      { id: "seed-docreq-rejected", reg: "seed-reg-b-done", title: "Kartu Identitas", instructions: null, dueAt: d(-25), status: "rejected", requestedBy: "seed-user-rec-elev", submittedAt: d(-26), reviewedBy: "seed-user-rec-elev", reviewedAt: d(-24), reviewNote: "Foto buram dan tidak terbaca.", revisionCount: 1 },
      { id: "seed-docreq-cancelled", reg: "seed-reg-a-done", title: "Surat Domisili", instructions: null, dueAt: d(-20), status: "cancelled", requestedBy: "seed-user-rec-elev", submittedAt: null, reviewedBy: null, reviewedAt: null, reviewNote: null, revisionCount: 0 },
    ];
    for (const q of docReqs) {
      await sql`
        INSERT INTO competition_document_requests (id, registration_id, title, instructions,
          due_at, status, requested_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at,
          review_note, revision_count)
        VALUES (${q.id}, ${q.reg}, ${q.title}, ${q.instructions}, ${q.dueAt}, ${q.status},
          ${q.requestedBy}, ${q.submittedAt}, ${q.reviewedBy}, ${q.reviewedAt},
          ${q.reviewNote}, ${q.revisionCount})
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, instructions = EXCLUDED.instructions, due_at = EXCLUDED.due_at,
          status = EXCLUDED.status, submitted_at = EXCLUDED.submitted_at,
          reviewed_by_user_id = EXCLUDED.reviewed_by_user_id, reviewed_at = EXCLUDED.reviewed_at,
          review_note = EXCLUDED.review_note, revision_count = EXCLUDED.revision_count,
          updated_at = now()
      `;
    }
    const docFiles = [
      { id: "seed-docfile-submitted", req: "seed-docreq-submitted", key: "registration-documents/seed-comp-closing/seed-reg-tb-b/seed-docreq-submitted/seed-file", name: "ktm-bela.jpg", size: 234567, mime: "image/jpeg" },
      { id: "seed-docfile-accepted", req: "seed-docreq-accepted", key: "registration-documents/seed-comp-done/seed-reg-a-done/seed-docreq-accepted/seed-file", name: "ktp-andi.jpg", size: 198765, mime: "image/jpeg" },
    ];
    for (const f of docFiles) {
      await sql`
        INSERT INTO competition_document_request_files (id, request_id, r2_key, original_file_name,
          file_size_bytes, content_type)
        VALUES (${f.id}, ${f.req}, ${f.key}, ${f.name}, ${f.size}, ${f.mime})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // -------------------------------------------------------- notifications
    const notifs = [
      { id: "seed-notif-a1", user: "seed-user-cand-a", type: "result_published", title: "Hasil kompetisi diumumkan", body: "Hasil Seed Scientific Writing Festival telah diumumkan. Selamat, Juara 1!", readAt: null, createdAt: d(-14) },
      { id: "seed-notif-a2", user: "seed-user-cand-a", type: "registration_confirmed", title: "Pendaftaran dikonfirmasi", body: "Pendaftaran Anda di Seed Hackathon Nusantara telah dikonfirmasi.", readAt: h(-20), createdAt: d(-1) },
      { id: "seed-notif-a3", user: "seed-user-cand-a", type: "registration_document_requested", title: "Dokumen diminta panitia", body: "Panitia Seed Coding League meminta Kartu Pelajar / KTM sebelum tenggat.", readAt: null, createdAt: h(-6) },
      { id: "seed-notif-b1", user: "seed-user-cand-b", type: "submission_finalized", title: "Karya difinalisasi", body: "Karya Anda untuk Seed Scientific Writing Festival telah difinalisasi.", readAt: d(-21), createdAt: d(-22) },
    ];
    for (const n of notifs) {
      await sql`
        INSERT INTO notifications (id, user_id, type, title, body, read_at, created_at)
        VALUES (${n.id}, ${n.user}, ${n.type}, ${n.title}, ${n.body}, ${n.readAt}, ${n.createdAt})
        ON CONFLICT (id) DO UPDATE SET read_at = EXCLUDED.read_at
      `;
    }

    // ----------------------------------------- institution invitations
    await sql`
      INSERT INTO institution_invitations (id, institution_id, invited_email, invited_role,
        token_hash, status, invited_by_user_id, target_user_id, expires_at)
      VALUES ('seed-instinv-1', 'seed-inst-a', ${EMAIL("seed.rec.rej")}, 'institution_staff',
        ${sha256("seed-inst-invite-1")}, 'pending', 'seed-user-rec-elev', 'seed-user-rec-rej', ${d(7)})
      ON CONFLICT (id) DO UPDATE SET
        status = 'pending', target_user_id = EXCLUDED.target_user_id,
        expires_at = EXCLUDED.expires_at, accepted_at = NULL
    `;
    await sql`
      INSERT INTO institution_invitations (id, institution_id, invited_email, invited_role,
        token_hash, status, invited_by_user_id, target_user_id, expires_at)
      VALUES ('seed-instinv-2', 'seed-inst-a', ${EMAIL("seed.newuser")}, 'institution_member',
        ${sha256("seed-inst-invite-2")}, 'pending_claim', 'seed-user-rec-elev', NULL, ${d(7)})
      ON CONFLICT (id) DO UPDATE SET
        status = 'pending_claim', target_user_id = NULL,
        expires_at = EXCLUDED.expires_at, accepted_at = NULL
    `;

    // -------------------------------- recruiter verification submissions
    type RvsSeed = {
      id: string; user: string; fullName: string; mobile: string;
      corporateEmail: string | null; emailFlag: boolean | null; vouchedAt: Date | null;
      status: string; rejectionReason: string | null; resubAllowed: boolean; resubCount: number;
      firstAt: Date; submittedAt: Date; reviewedAt: Date | null; reviewer: string | null;
    };
    const rvs: RvsSeed[] = [
      { id: "seed-rvs-min", user: "seed-user-rec-min", fullName: "Rina Wijaya", mobile: "+6281200001111", corporateEmail: null, emailFlag: null, vouchedAt: null, status: "pending_review", rejectionReason: null, resubAllowed: true, resubCount: 0, firstAt: d(-2), submittedAt: d(-2), reviewedAt: null, reviewer: null },
      { id: "seed-rvs-dual", user: "seed-user-dual", fullName: "Dina Kusuma", mobile: "+6281200002222", corporateEmail: "dina@seedcorp.example", emailFlag: true, vouchedAt: d(-1), status: "pending_review", rejectionReason: null, resubAllowed: true, resubCount: 0, firstAt: d(-1), submittedAt: d(-1), reviewedAt: null, reviewer: null },
      { id: "seed-rvs-elev", user: "seed-user-rec-elev", fullName: "Eko Prasetyo", mobile: "+6281200003333", corporateEmail: "eko@seed-academy.example", emailFlag: true, vouchedAt: null, status: "approved", rejectionReason: null, resubAllowed: true, resubCount: 0, firstAt: d(-40), submittedAt: d(-40), reviewedAt: d(-39), reviewer: "seed-user-ops" },
      { id: "seed-rvs-rej", user: "seed-user-rec-rej", fullName: "Raka Nugraha", mobile: "+6281200004444", corporateEmail: null, emailFlag: null, vouchedAt: null, status: "rejected", rejectionReason: "Nomor tidak dapat dihubungi dan dokumen tidak jelas.", resubAllowed: true, resubCount: 1, firstAt: d(-10), submittedAt: d(-5), reviewedAt: d(-1), reviewer: "seed-user-ops" },
      { id: "seed-rvs-draft", user: "seed-user-rec-draft", fullName: "Dodi Firmansyah", mobile: "+6281200005555", corporateEmail: null, emailFlag: null, vouchedAt: null, status: "draft", rejectionReason: null, resubAllowed: true, resubCount: 0, firstAt: d(-8), submittedAt: d(-8), reviewedAt: null, reviewer: null },
    ];
    for (const v of rvs) {
      await sql`
        INSERT INTO recruiter_verification_submissions (id, user_id, full_name, mobile_number,
          corporate_email, email_domain_flag, vouched_at, status, rejection_reason,
          resubmission_allowed, resubmission_count, first_submitted_at, submitted_at,
          reviewed_at, reviewer_user_id)
        VALUES (${v.id}, ${v.user}, ${v.fullName}, ${v.mobile}, ${v.corporateEmail}, ${v.emailFlag},
          ${v.vouchedAt}, ${v.status}, ${v.rejectionReason}, ${v.resubAllowed}, ${v.resubCount},
          ${v.firstAt}, ${v.submittedAt}, ${v.reviewedAt}, ${v.reviewer})
        ON CONFLICT (id) DO UPDATE SET
          full_name = EXCLUDED.full_name, mobile_number = EXCLUDED.mobile_number,
          corporate_email = EXCLUDED.corporate_email, email_domain_flag = EXCLUDED.email_domain_flag,
          vouched_at = EXCLUDED.vouched_at, status = EXCLUDED.status,
          rejection_reason = EXCLUDED.rejection_reason,
          resubmission_allowed = EXCLUDED.resubmission_allowed,
          resubmission_count = EXCLUDED.resubmission_count,
          first_submitted_at = EXCLUDED.first_submitted_at, submitted_at = EXCLUDED.submitted_at,
          reviewed_at = EXCLUDED.reviewed_at, reviewer_user_id = EXCLUDED.reviewer_user_id
      `;
    }
    await sql`
      INSERT INTO recruiter_verification_documents (id, submission_id, r2_key, original_file_name,
        file_size_bytes, content_type)
      VALUES ('seed-rvd-1', 'seed-rvs-min',
        'recruiter-verification/seed-user-rec-min/seed-rvs-min/seed-file',
        'surat-keterangan-kerja.pdf', 145678, 'application/pdf')
      ON CONFLICT (id) DO NOTHING
    `;

    // ------------------------------ institution verification submissions
    await sql`
      INSERT INTO institution_verification_submissions (id, institution_id, submitted_by_user_id,
        target_institution_type, status, email_domain_flag, submitted_at)
      VALUES ('seed-ivs-b', 'seed-inst-b', 'seed-user-rec-elev', 'company', 'pending_review',
        false, ${d(-3)})
      ON CONFLICT (id) DO UPDATE SET
        status = 'pending_review', submitted_at = EXCLUDED.submitted_at,
        reviewed_at = NULL, reviewer_user_id = NULL, reviewer_notes = NULL
    `;
    const ivsDocs = [
      { id: "seed-ivd-npwp", type: "npwp", name: "npwp-seed-ventures.pdf" },
      { id: "seed-ivd-nib", type: "nib", name: "nib-seed-ventures.pdf" },
    ];
    for (const dcm of ivsDocs) {
      await sql`
        INSERT INTO institution_verification_documents (id, submission_id, document_type, r2_key,
          original_file_name, file_size_bytes, content_type)
        VALUES (${dcm.id}, 'seed-ivs-b', ${dcm.type},
          ${"institution-verification/seed-inst-b/seed-ivs-b/" + dcm.id},
          ${dcm.name}, 156789, 'application/pdf')
        ON CONFLICT (id) DO NOTHING
      `;
    }

    // -------------------------------------------------------------- reviews
    await sql`
      INSERT INTO competition_reviews (id, competition_id, author_user_id, rating, body, status)
      VALUES ('seed-rev-visible', 'seed-comp-done', 'seed-user-cand-a', 5,
        'Kompetisi terbaik yang pernah saya ikuti — panitia responsif!', 'visible')
      ON CONFLICT (competition_id, author_user_id) DO UPDATE SET
        rating = EXCLUDED.rating, body = EXCLUDED.body, status = EXCLUDED.status, updated_at = now()
    `;
    await sql`
      INSERT INTO competition_reviews (id, competition_id, author_user_id, rating, body, status)
      VALUES ('seed-rev-hidden', 'seed-comp-done', 'seed-user-cand-c', 2,
        'Pengumuman hasil sangat lambat.', 'hidden')
      ON CONFLICT (competition_id, author_user_id) DO UPDATE SET
        rating = EXCLUDED.rating, body = EXCLUDED.body, status = EXCLUDED.status, updated_at = now()
    `;

    // ------------------------------------------------- reset automation scratch
    // The automated pass writes to a few rows (uploads a submission and finalizes it, raises and
    // reviews a document request). Clearing them here is what makes the whole pipeline re-runnable
    // rather than one-shot. Only rows the automation creates are removed.
    await sql`DELETE FROM competition_submissions WHERE registration_id = 'seed-reg-a-inprog'`;
    await sql`
      DELETE FROM competition_document_requests
      WHERE registration_id IN (SELECT id FROM competition_registrations WHERE id LIKE 'seed-reg-%')
        AND id NOT LIKE 'seed-docreq-%'
    `;
    // Those writes also emit notifications (submission_finalized, registration_document_*), which
    // are rows in their own right and survive the deletes above. Left alone they accumulate one
    // per run and drift the unread-count assertion. Seeded notifications carry a `seed-notif-`
    // id; everything else against a seed account was produced by the automation.
    await sql`
      DELETE FROM notifications
      WHERE user_id LIKE 'seed-user-%' AND id::text NOT LIKE 'seed-notif-%'
    `;
    // The participation decision is one-way by design: confirmCompetitionWillProceed CASes on
    // participation_confirmed_at IS NULL, so there is no API path back. Clearing it here is what
    // lets the owner-side assertion run more than once.
    await sql`
      UPDATE competitions SET participation_confirmed_at = NULL, updated_at = now()
      WHERE id = 'seed-comp-closed' AND participation_confirmed_at IS NOT NULL
    `;
    // Teams the team-lifecycle assertions build. They delete what they create, but a run that dies
    // mid-flow would otherwise leave a captain occupying the only free slot on seed-comp-teamopen
    // and every later run would fail at team creation.
    await sql`
      DELETE FROM teams WHERE competition_id = 'seed-comp-teamopen' AND id NOT LIKE 'seed-team-%'
    `;
    // Institution invitations and memberships from the invite assertions, on the same principle.
    await sql`
      DELETE FROM institution_invitations
      WHERE institution_id LIKE 'seed-inst-%' AND id NOT LIKE 'seed-instinv-%'
    `;
    await sql`
      DELETE FROM institution_memberships
      WHERE institution_id LIKE 'seed-inst-%' AND id NOT LIKE 'seed-mem-%'
    `;

    // -------------------------------------------------------------- summary
    const counts = await sql<{ label: string; n: number }[]>`
      SELECT 'users' AS label, count(*)::int AS n FROM users WHERE id LIKE 'seed-user-%'
      UNION ALL SELECT 'institutions', count(*)::int FROM institutions WHERE id LIKE 'seed-inst-%'
      UNION ALL SELECT 'competitions', count(*)::int FROM competitions WHERE id LIKE 'seed-comp-%'
      UNION ALL SELECT 'registrations', count(*)::int FROM competition_registrations WHERE id LIKE 'seed-reg-%'
      UNION ALL SELECT 'teams', count(*)::int FROM teams WHERE id LIKE 'seed-team-%'
      UNION ALL SELECT 'submissions', count(*)::int FROM competition_submissions WHERE id LIKE 'seed-sub-%'
      UNION ALL SELECT 'results', count(*)::int FROM competition_results WHERE id LIKE 'seed-res-%'
      UNION ALL SELECT 'doc_requests', count(*)::int FROM competition_document_requests WHERE id LIKE 'seed-docreq-%'
      UNION ALL SELECT 'notifications', count(*)::int FROM notifications WHERE id LIKE 'seed-notif-%'
      UNION ALL SELECT 'recruiter_verifs', count(*)::int FROM recruiter_verification_submissions WHERE id LIKE 'seed-rvs-%'
      UNION ALL SELECT 'inst_verifs', count(*)::int FROM institution_verification_submissions WHERE id LIKE 'seed-ivs-%'
    `;
    for (const row of counts) console.log(`${row.label.padEnd(18)} ${row.n}`);
    console.log("Seed complete. All seed accounts use password: UjiCoba123!");
  } finally {
    await sql.end();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
