/**
 * Reserved username / slug words — the single authoritative source of truth.
 *
 * A word in this list cannot be claimed as a `/{username}` handle, because it
 * would collide with a current or future top-level system route segment. The
 * institution-slug creation/edit path imports this same module to
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
 */
export const RESERVED_WORDS: readonly string[] = [
  // --- System route segments ---
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
  // Live top-level App Router segments added per the same-commit convention above.
  "invitations",
  "protected",
  // Static create-action segments under /institution/ that must never be claimed as an institution
  // slug, or the static route would shadow /institution/<slug> and make that institution
  // unreachable. Personal institutions share the flat /institution/<slug> namespace,
  // so reserving these keeps the create surfaces collision-free.
  "personal",
  "workspace",
  "create",

  // --- Carried forward from the original RESERVED_USERNAMES set ---
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

  // --- Security-relevant additions beyond the route segments ---
  // Defensive: handles that read as system / internal identities or that commonly
  // map to infrastructure subdomains.
  "root",
  "support",
  "www",
  // `user` is the synthetic base `normalizeUsernameBase` falls back to when a
  // name yields no usable ASCII (e.g. a fully non-Latin-script name). Reserving
  // the bare word keeps the `user_NNNN` fallback namespace synthetic-only and
  // stops a real account from claiming the ambiguous bare `user` handle.
  "user",
];
