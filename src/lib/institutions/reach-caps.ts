// Reach caps for a personal institution. Enforced server-side at the existing gates (publish,
// competition-create, featured, invitation). Shared constants — never inline.
//
// WHY THESE LIVE IN `lib/` AND NOT BESIDE THE TYPE TAXONOMY. `institution-type.ts` imports
// `@/server/db/schema` for its enum values, so anything that module exports drags Drizzle into the
// bundle of every client component that imports it. That is fine for the server services, and it is
// not fine for the publish control: it renders in the browser and has to NAME the cap in an
// Indonesian sentence. Client components reach the taxonomy through the `isPersonal` prop for
// exactly this reason. This module imports nothing, so both sides can have the same number.

export const MAX_PUBLISHED_COMPETITIONS_FOR_PERSONAL = 2;
