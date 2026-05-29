/**
 * Step 4.5 verification — saved competitions preview cap (Step 6 of manual checklist).
 *
 * Verifies that listSavedCompetitions called with { limit: 5 } returns exactly 5 items
 * for nicholasbryan250@gmail.com even though 6 saves exist, and that calling with
 * { limit: 100 } returns all 6.
 *
 * Run with: node --import tsx src/server/scripts/verify-step-4.5-saved-cap.ts
 */

import { existsSync } from "node:fs";

const loadLocalEnvFiles = (): void => {
  const candidates = [".env.local", ".env"];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
  }
};

type CheckResult = { id: string; description: string; status: "PASS" | "FAIL"; detail?: string };

const run = async (): Promise<void> => {
  loadLocalEnvFiles();
  process.env.RUNTIME_NAME = process.env.RUNTIME_NAME ?? "web";

  const { assertRuntimeEnv, resolveServerRuntime } = await import("@/config/env.server");
  assertRuntimeEnv(resolveServerRuntime(process.env.RUNTIME_NAME));

  const { getDb } = await import("@/server/db/client");
  const { users } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const { listSavedCompetitions } = await import(
    "@/server/saved-competitions/saved-competition-service"
  );

  const db = getDb();
  const results: CheckResult[] = [];

  const record = (id: string, description: string, pass: boolean, detail?: string) => {
    results.push({ id, description, status: pass ? "PASS" : "FAIL", detail });
    const tag = pass ? "✓" : "✗";
    console.log(`${tag} [${id}] ${description}${detail ? ` — ${detail}` : ""}`);
  };

  // ── Resolve user ────────────────────────────────────────────────────────────
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, "nicholasbryan250@gmail.com"))
    .limit(1);

  if (!user) throw new Error("User nicholasbryan250@gmail.com not found");

  console.log(`\nUser: ${user.email} (${user.id})\n`);
  console.log("─────────────────────────────────────────────────────");
  console.log("Step 4.5 — Saved Preview Cap (Manual Test Step 6)");
  console.log("─────────────────────────────────────────────────────");

  // ── SAVE-1: { limit: 5 } returns exactly 5 data rows ───────────────────────
  const preview = await listSavedCompetitions(user.id, { limit: 5 }, db);
  record("SAVE-1", "{ limit: 5 } returns exactly 5 items in data array", preview.data.length === 5, `got ${preview.data.length}`);

  // ── SAVE-2: meta.total reflects all 6 saves (not capped) ───────────────────
  record("SAVE-2", "meta.total is 6 (full count, not capped by limit)", preview.meta.total === 6, `got ${preview.meta.total}`);

  // ── SAVE-3: meta.totalPages is 2 — ceil(6/5) ───────────────────────────────
  record("SAVE-3", "meta.totalPages is 2 (ceil(6/5))", preview.meta.totalPages === 2, `got ${preview.meta.totalPages}`);

  // ── SAVE-4: meta.limit echoes back the requested limit ─────────────────────
  record("SAVE-4", "meta.limit echoes back 5", preview.meta.limit === 5, `got ${preview.meta.limit}`);

  // ── SAVE-5: all preview items are available (published competitions) ─────────
  const allAvailable = preview.data.every((i) => i.savedStatus === "available");
  record("SAVE-5", "all 5 preview items have savedStatus = 'available'", allAvailable, `statuses: ${preview.data.map((i) => i.savedStatus).join(", ")}`);

  // ── SAVE-6: { limit: 100 } returns all 6 saves ─────────────────────────────
  const full = await listSavedCompetitions(user.id, { limit: 100 }, db);
  record("SAVE-6", "{ limit: 100 } returns all 6 saves", full.data.length === 6, `got ${full.data.length}`);

  // ── SAVE-7: all 6 seeded titles present in the full list ────────────────────
  const expectedTitles = [
    "Lomba Desain UI 2026",
    "Kompetisi Data Science Nasional",
    "Hackathon Energi Terbarukan",
    "Olimpiade Matematika Mahasiswa",
    "Business Plan Competition 2026",
    "Lomba Karya Tulis Ilmiah 2026",
  ];
  const returnedTitles = full.data.map((i) => i.title);
  const allPresent = expectedTitles.every((t) => returnedTitles.includes(t));
  record("SAVE-7", "all 6 seeded titles present in full list", allPresent, `found: ${returnedTitles.join(" | ")}`);

  // ── SAVE-8: preview titles are a subset of the full 6 ──────────────────────
  const previewTitles = preview.data.map((i) => i.title);
  const subsetOk = previewTitles.every((t) => returnedTitles.includes(t));
  record("SAVE-8", "preview 5 titles are a strict subset of the full 6", subsetOk, `preview: ${previewTitles.join(" | ")}`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("─────────────────────────────────────────────────────");
  const failed = results.filter((r) => r.status === "FAIL");
  if (failed.length > 0) {
    console.log(`\nFAIL — ${failed.length} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nALL ${results.length} CHECKS PASSED`);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
