// @vitest-environment node
//
// WHAT AN INSTITUTION EXPOSES PUBLICLY — against a real Postgres.
//
// Two questions are asked here, and they have DIFFERENT answers, which is the point (DEC-0158):
//
//   1. Does the page render?     Suspended institutions only. Verification is not a rendering gate,
//                                because a free competition publishes from an unverified organizer.
//   2. Does it get indexed?      Rendering, minus personal institutions, minus anything unverified.
//
// The sitemap answers (2) in a WHERE clause and `generateMetadata` answers it in memory, so the two
// are separate spellings of one rule and nothing but a test keeps them in step. The grid below walks
// every combination of verification status, institution type and suspension and asserts they agree —
// because the failure this guards is a sitemap that starts advertising organizers whose own page
// says "do not index", and the sitemap is the copy nobody opens.
//
// The contact fields are the other half. They are gated on verification AND on who is asking, and the
// decision is made on the server against the database: the fields are nulled in the payload rather
// than hidden in markup, so a viewer who may not see a contact is never handed one to not render.
// Every viewer class below is a real `users` row with a real `institution_memberships` row.
//
// Every test except the last runs inside a transaction that is ALWAYS rolled back. The last one calls
// the public API route, which reads the pooled connection and therefore cannot see an uncommitted
// row — it commits and deletes what it wrote.

import { afterAll, describe, expect, it, vi } from "vitest";
import { TransactionRollbackError, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { competitions, institutionMemberships, institutions, users } from "@/server/db/schema";
import { TEST_DATABASE_URL, skipWithoutDatabase } from "@/server/testing/database-url";
import type { Database } from "@/server/db/client";
import { NEW_INSTITUTION_DEFAULT_STATUS } from "@/server/institution-workspace/institution-service";
import {
  ANONYMOUS_INSTITUTION_VIEWER,
  getPublicInstitution,
  isIndexableInstitution,
  listSitemapInstitutions,
  type InstitutionPublicViewer,
} from "@/server/institution-workspace/institution-public-service";

const DATABASE_URL = TEST_DATABASE_URL;
const client = DATABASE_URL ? postgres(DATABASE_URL, { max: 1 }) : null;
const db = client ? drizzle(client, { schema }) : null;

afterAll(async () => {
  await client?.end();
});

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const inRollback = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
  if (!db) throw new Error("no database");
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
};

let seq = 0;
// Hyphen-separated, not underscore-separated: an institution slug goes through
// `normalizeInstitutionSlug` on the way in from a URL, which rewrites `_` to `-`. A fixture slug
// carrying an underscore is one no route could ever address and no membership lookup could match.
const uniqueSuffix = (): string => `${Date.now()}-${seq++}`;

type VerificationStatus = "pending_verification" | "under_review" | "verified" | "rejected";
type InstitutionType = "company" | "foundation" | "university" | "campus_organization" | "personal";

type SeedOptions = {
  verificationStatus?: VerificationStatus;
  institutionType?: InstitutionType;
  suspended?: boolean;
  contact?: boolean;
};

const seedInstitution = async (
  tx: Tx,
  options: SeedOptions = {},
): Promise<{ id: string; slug: string }> => {
  const id = uniqueSuffix();
  const institutionType = options.institutionType ?? "company";
  const hasContact = options.contact ?? false;

  const [row] = await tx
    .insert(institutions)
    .values({
      slug: `exposure-inst-${id}`,
      institutionType,
      // `institutions_display_name_type_chk` allows a null display name only for `personal`.
      displayName: institutionType === "personal" ? null : `Exposure Fixture ${id}`,
      // The value the production creation path writes, not the column's schema default.
      status: NEW_INSTITUTION_DEFAULT_STATUS,
      verificationStatus: options.verificationStatus ?? "pending_verification",
      suspendedAt: options.suspended ? new Date() : null,
      suspensionReason: options.suspended ? "integration fixture" : null,
      contactName: hasContact ? "Panitia Expo" : null,
      contactEmail: hasContact ? `panitia_${id}@example.test` : null,
      contactPhone: hasContact ? "+62215550123" : null,
    })
    .returning({ id: institutions.id, slug: institutions.slug });

  return row!;
};

const seedUser = async (
  tx: Tx,
  role: "candidate" | "recruiter" | "platform_ops" = "candidate",
): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(users)
    .values({
      email: `exposure_${id}@example.test`,
      username: `exposure_${id}`,
      role,
      candidateVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  return row!.id;
};

const addMembership = async (
  tx: Tx,
  institutionId: string,
  userId: string,
  membershipRole: "institution_owner" | "institution_staff" | "institution_member",
): Promise<void> => {
  await tx
    .insert(institutionMemberships)
    .values({ institutionId, userId, membershipRole, status: "active" });
};

const sitemapSlugs = async (tx: Tx): Promise<string[]> =>
  (await listSitemapInstitutions(tx as unknown as Database)).map((entry) => entry.slug);

const pageFor = async (tx: Tx, slug: string, viewer?: InstitutionPublicViewer) =>
  getPublicInstitution(slug, viewer ?? ANONYMOUS_INSTITUTION_VIEWER, tx as unknown as Database);

/**
 * The page's own indexing answer, composed exactly as `generateMetadata` composes it.
 *
 * A page that does not render emits no `robots` directive either — the not-found branch returns a
 * title and nothing else — so a missing page and a non-indexable page are the same answer here.
 */
const pageIsIndexable = async (tx: Tx, slug: string): Promise<boolean> => {
  const page = await pageFor(tx, slug);
  return page !== null && isIndexableInstitution(page);
};

describe.skipIf(skipWithoutDatabase)(
  "sitemap membership and the page's robots answer agree",
  () => {
    it("agrees over every verification status, institution type and suspension state", async () => {
      const statuses: VerificationStatus[] = [
        "pending_verification",
        "under_review",
        "verified",
        "rejected",
      ];
      const types: InstitutionType[] = ["company", "personal"];

      await inRollback(async (tx) => {
        const seeded: { slug: string; label: string }[] = [];

        for (const verificationStatus of statuses) {
          for (const institutionType of types) {
            for (const suspended of [false, true]) {
              const institution = await seedInstitution(tx, {
                verificationStatus,
                institutionType,
                suspended,
              });
              seeded.push({
                slug: institution.slug,
                label: `${verificationStatus}/${institutionType}/suspended=${suspended}`,
              });
            }
          }
        }

        const sitemap = await sitemapSlugs(tx);

        for (const { slug, label } of seeded) {
          expect(
            sitemap.includes(slug),
            `${label}: the sitemap and the page's robots directive disagree`,
          ).toBe(await pageIsIndexable(tx, slug));
        }

        // The grid is only meaningful if it produced both answers. Without this the whole block would
        // pass against a sitemap that listed nothing and a page that indexed nothing.
        const indexed = seeded.filter(({ slug }) => sitemap.includes(slug));
        expect(indexed.length).toBeGreaterThan(0);
        expect(indexed.length).toBeLessThan(seeded.length);
      });
    });

    it("keeps rendering an unverified organizer's page while withholding it from the sitemap", async () => {
      await inRollback(async (tx) => {
        const institution = await seedInstitution(tx, {
          verificationStatus: "pending_verification",
          institutionType: "company",
          suspended: false,
        });

        const page = await pageFor(tx, institution.slug);

        expect(
          page,
          "a free competition may publish from an unverified institution (DEC-0158), so its page must render; only verified institutions are indexed",
        ).not.toBeNull();
        expect(isIndexableInstitution(page!)).toBe(false);
        expect(await sitemapSlugs(tx)).not.toContain(institution.slug);
      });
    });

    it("keeps the render predicate on suspension alone", async () => {
      await inRollback(async (tx) => {
        const active = await seedInstitution(tx, { verificationStatus: "rejected" });
        const suspended = await seedInstitution(tx, { suspended: true });

        // The render predicate is unchanged by this step, and the unverified-active row is what makes
        // the assertion discriminating: a predicate that had quietly grown a verification term would
        // still return the suspended row as null. `rejected` is used rather than `pending_verification`
        // so the row cannot be accused of passing on a status the gate might plausibly allow.
        expect(await pageFor(tx, active.slug)).not.toBeNull();
        expect(await pageFor(tx, suspended.slug)).toBeNull();
        // And the sitemap excludes the suspended row for the same reason the page does.
        expect(await sitemapSlugs(tx)).not.toContain(suspended.slug);
      });
    });
  },
);

describe.skipIf(skipWithoutDatabase)("contact disclosure by viewer", () => {
  const contactKeysOf = (page: {
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
  }) => ({
    contactName: page.contactName,
    contactEmail: page.contactEmail,
    contactPhone: page.contactPhone,
  });

  it("shows contacts to anyone once the institution is verified", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, {
        verificationStatus: "verified",
        contact: true,
      });

      const page = (await pageFor(tx, institution.slug))!;

      expect(page.contactDisclosure).toEqual({ kind: "public" });
      expect(contactKeysOf(page)).toEqual({
        contactName: "Panitia Expo",
        contactEmail: page.contactEmail,
        contactPhone: "+62215550123",
      });
      expect(page.contactEmail).toContain("@example.test");
    });
  });

  it("withholds contacts from an anonymous visitor of an unverified institution", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, { contact: true });

      const page = (await pageFor(tx, institution.slug))!;

      expect(page.contactDisclosure).toEqual({ kind: "hidden" });
      expect(contactKeysOf(page)).toEqual({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      });
    });
  });

  it("restores contacts to every membership role, and offers the verification link only to the admin roles", async () => {
    const cases = [
      { membershipRole: "institution_owner" as const, canRequestVerification: true },
      { membershipRole: "institution_staff" as const, canRequestVerification: true },
      // An ordinary member sees the contacts and cannot open the verification flow, so the notice
      // must not carry a link that would bounce them.
      { membershipRole: "institution_member" as const, canRequestVerification: false },
    ];

    for (const { membershipRole, canRequestVerification } of cases) {
      await inRollback(async (tx) => {
        const institution = await seedInstitution(tx, { contact: true });
        const viewerUserId = await seedUser(tx);
        await addMembership(tx, institution.id, viewerUserId, membershipRole);

        const page = (await pageFor(tx, institution.slug, {
          userId: viewerUserId,
          isPlatformOps: false,
          isPreview: false,
        }))!;

        expect(contactKeysOf(page), membershipRole).toEqual({
          contactName: "Panitia Expo",
          contactEmail: page.contactEmail,
          contactPhone: "+62215550123",
        });
        expect(page.contactDisclosure).toEqual({
          kind: "members_only",
          canRequestVerification,
        });
      });
    }
  });

  it("shows contacts to a platform_ops viewer who is not a member, without offering them the link", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, { contact: true });
      const operator = await seedUser(tx, "platform_ops");

      // Read from the same source of truth `requireSessionRole(["platform_ops"])` reads — the
      // session's role — rather than a membership row this viewer does not have.
      const page = (await pageFor(tx, institution.slug, {
        userId: operator,
        isPlatformOps: true,
        isPreview: false,
      }))!;

      expect(contactKeysOf(page).contactEmail).toContain("@example.test");
      expect(page.contactDisclosure).toEqual({
        kind: "members_only",
        canRequestVerification: false,
      });
    });
  });

  it("hides contacts in public preview even from the institution's own owner", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, { contact: true });
      const owner = await seedUser(tx, "recruiter");
      await addMembership(tx, institution.id, owner, "institution_owner");

      const preview = (await pageFor(tx, institution.slug, {
        userId: owner,
        isPlatformOps: false,
        isPreview: true,
      }))!;

      // `?tampilan=publik` exists so the owner can see the page AS A STRANGER WOULD. An owner shown
      // their own contacts under that flag is looking at a page no stranger gets.
      expect(preview.contactDisclosure).toEqual({ kind: "preview_hidden" });
      expect(contactKeysOf(preview)).toEqual({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      });
    });
  });

  it("omits the section for a member of a different institution", async () => {
    await inRollback(async (tx) => {
      const target = await seedInstitution(tx, { contact: true });
      const other = await seedInstitution(tx, { contact: true });
      const outsider = await seedUser(tx);
      await addMembership(tx, other.id, outsider, "institution_member");

      const page = (await pageFor(tx, target.slug, {
        userId: outsider,
        isPlatformOps: false,
        isPreview: false,
      }))!;

      // The membership is keyed to THIS institution. A member of one gains nothing on another.
      expect(page.contactDisclosure).toEqual({ kind: "hidden" });
      expect(contactKeysOf(page)).toEqual({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      });
    });
  });

  it("omits the section for an insider of an unverified institution that has no contact to show", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, { contact: false });
      const owner = await seedUser(tx, "recruiter");
      await addMembership(tx, institution.id, owner, "institution_owner");

      const page = (await pageFor(tx, institution.slug, {
        userId: owner,
        isPlatformOps: false,
        isPreview: false,
      }))!;

      expect(page.contactDisclosure).toEqual({ kind: "hidden" });
    });
  });

  it("never carries a contact for a personal institution, whatever the viewer", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, {
        institutionType: "personal",
        contact: true,
      });
      const owner = await seedUser(tx, "recruiter");
      await addMembership(tx, institution.id, owner, "institution_owner");

      const page = (await pageFor(tx, institution.slug, {
        userId: owner,
        isPlatformOps: false,
        isPreview: false,
      }))!;

      // The page only redirects to the owner's profile, so no contact section is ever rendered —
      // including for the owner, who would otherwise be told "only members can see this".
      expect(page.contactDisclosure).toEqual({ kind: "hidden" });
      expect(contactKeysOf(page)).toEqual({
        contactName: null,
        contactEmail: null,
        contactPhone: null,
      });
    });
  });
});

// ─── The public API carries no contact ────────────────────────────────────────
//
// THE ONE MOCK IN THIS FILE, and it is drawn at connection selection rather than at the route. The
// fixtures are seeded inside a transaction this file opened on its own client, and that transaction
// is never committed. The route reads the application's POOLED client instead — `getDb()` builds a
// five-connection pool over `DATABASE_URL` (server/db/client.ts:28-54) — and a second connection
// cannot see another session's uncommitted rows, so an unmocked route would answer 404 over fixtures
// that are right there. The mock is what puts the route and the fixtures on ONE connection.
//
// It is not a workaround for a missing variable. Run this suite the way CI runs it, `DATABASE_URL` is
// exported into the process alongside `REQUIRE_DB_TESTS=1` (.github/workflows/ci.yml:46-52), and
// `getDb()` is fully configured and reachable. The reason the mock is needed is the connection, not
// the environment.
//
// What that leaves real: the route handler, its 200/404/500 branches, the service, every query, and
// the serialization — this is the response body an anonymous caller receives. What it replaces is
// only which connection that response is produced on, which is why the fixtures below are built by
// real inserts through the real schema rather than assembled as an object (Rule 33).
let routeTransaction: Database | null = null;

vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  getDb: () => {
    if (!routeTransaction) throw new Error("the route read the database outside a seeded test");
    return routeTransaction;
  },
}));

const seedCompetition = async (tx: Tx, institutionId: string): Promise<string> => {
  const id = uniqueSuffix();
  const [row] = await tx
    .insert(competitions)
    .values({
      institutionId,
      slug: `exposure-comp-${id}`,
      title: `Exposure fixture ${id}`,
      status: "published",
      publishedAt: new Date(),
    })
    .returning({ slug: competitions.slug });
  return row!.slug;
};

describe.skipIf(skipWithoutDatabase)("the unauthenticated competition detail response", () => {
  it("contains no organizer contact key at any depth", async () => {
    await inRollback(async (tx) => {
      const institution = await seedInstitution(tx, {
        verificationStatus: "verified",
        contact: true,
      });
      const competitionSlug = await seedCompetition(tx, institution.id);
      routeTransaction = tx as unknown as Database;

      const { GET } =
        await import("@/app/api/v1/competitions/public/[institutionSlug]/[slug]/route");
      const response = await GET(
        new Request("http://localhost/", { headers: { Accept: "application/json" } }) as never,
        { params: Promise.resolve({ institutionSlug: institution.slug, slug: competitionSlug }) },
      );

      // The route has no session call at all, so this IS what an anonymous caller receives.
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.competition.organizer.name).toBe(await readDisplayName(tx, institution.id));

      // Depth-first over the WHOLE payload rather than one object: moving a contact somewhere else
      // in the response would satisfy an assertion made about `organizer`.
      expect(findKeys(body, ["contactName", "contactEmail", "contactPhone"])).toEqual([]);

      // The control. The same institution's own public page DOES carry the contact for an anonymous
      // viewer once verified, so the absence above is a property of this endpoint rather than of a
      // fixture that never had a contact to leak.
      const page = (await pageFor(tx, institution.slug))!;
      expect(page.contactEmail).toContain("@example.test");
    });
    routeTransaction = null;
  });
});

const readDisplayName = async (tx: Tx, institutionId: string): Promise<string> => {
  const [row] = await tx
    .select({ displayName: institutions.displayName })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  return row!.displayName!;
};

const findKeys = (value: unknown, keys: string[], path = ""): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findKeys(item, keys, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(keys.includes(key) ? [`${path}.${key}`] : []),
      ...findKeys(child, keys, `${path}.${key}`),
    ]);
  }
  return [];
};
