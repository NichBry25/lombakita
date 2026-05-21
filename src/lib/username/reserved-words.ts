/**
 * Reserved username / slug words — the single authoritative source of truth.
 *
 * A word in this list cannot be claimed as a `/{username}` handle, because it
 * would collide with a current or future top-level system route segment. From
 * Step 2.2 the institution-slug creation/edit path imports this same module to
 * protect the institution-slug namespace — there is exactly one list.
 *
 * HOW TO EXTEND: when a new top-level route segment is added to the app, add the
 * segment to `RESERVED_WORDS` in the same commit. Never duplicate this list into
 * another file — both the username module and the institution-slug module import
 * it from here.
 *
 * Matching is case-insensitive: every consumer lowercases input before comparing,
 * so every entry here is lowercase. Exported as a plain `string[]` so it can be
 * imported by either namespace module without circular dependencies.
 *
 * Step 2.1a / DEC-0054.
 */
export const RESERVED_WORDS: readonly string[] = [
  // --- CCR-20 / B8 mandated minimum (system route segments) ---
  "auth",
  "profile",
  "settings",
  "candidate-dashboard",
  "recruiter-dashboard",
  "institution",
  "notifications",
  "certificates",
  "competitions",
  "compete",
  "hackathons",
  "scholarships",
  "workshops",
  "conferences",
  "faq",
  "about",
  "terms",
  "privacy",
  "refund-policy",
  "admin",
  "api",
  "static",
  // Live top-level App Router segments not in the CCR-20 text but already
  // routable — added per the same-commit convention (Step 2.1a depth review).
  "invitations",
  "protected",

  // --- Carried forward from the Step 2.1 RESERVED_USERNAMES set ---
  // Kept so centralising the list does not regress the username namespace.
  "competition",
  "institutions",
  "candidate",
  "recruiter",
  "student",
  "saved",
  "dashboard",
  "search",
  "explore",
  "register",
  "login",
  "logout",
  "signup",
  "signin",
  "signout",
  "me",
  "contact",
  "legal",
  "help",
  "null",
  "undefined",

  // --- Security-relevant additions beyond the CCR-20 minimum (Step 2.1a) ---
  // Defensive: handles that read as system / internal identities or that commonly
  // map to infrastructure subdomains. Documented in the Step 2.1a commit.
  "root",
  "support",
  "www",
  // `user` is the synthetic base `normalizeUsernameBase` falls back to when a
  // name yields no usable ASCII (e.g. a fully non-Latin-script name). Reserving
  // the bare word keeps the `user_NNNN` fallback namespace synthetic-only and
  // stops a real account from claiming the ambiguous bare `user` handle
  // (Step 2.1a depth review, D1).
  "user",
];
