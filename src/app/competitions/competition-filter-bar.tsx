"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CompetitionFilters } from "./competition-filters";
import type { CompetitionSearchParams } from "./search-params";
import { competitionsHref } from "./search-params";

/**
 * The filter row, wired to the URL rather than to local state.
 *
 * The page reads its filters from the query string on the server, so a change here has to land in
 * the URL for anything to happen. That is also what makes a filtered view shareable, reloadable
 * and crawlable: the address bar holds the whole state of the page.
 *
 * The applied filters arrive as props rather than from `useSearchParams`, so this component reads
 * the same values the server rendered from and does not have to re-derive them.
 *
 * PENDING STATE. This route has no `loading.tsx`, because a route-level Suspense boundary makes
 * Next stream a skeleton into the shell and deliver the listing inside a hidden element that only
 * a script can reveal, which leaves a reader without JavaScript looking at a placeholder forever.
 * That is the defect this page was rewritten to remove. A navigation still has to show that it is
 * running, so the transition drives the spinner beside the controls and `aria-busy` on the row
 * that owns them.
 */
export function CompetitionFilterBar({ params }: { params: CompetitionSearchParams }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const update = (key: keyof CompetitionSearchParams, value: string) => {
    // A changed filter re-selects the result set, so the old page number no longer refers to
    // anything. Landing on page 4 of a two-page set shows an empty grid.
    const href = competitionsHref(params, { [key]: value || undefined, page: undefined });
    startTransition(() => router.push(href));
  };

  return (
    <CompetitionFilters
      isPending={isPending}
      category={params.category ?? ""}
      mode={params.mode ?? ""}
      status={params.status ?? ""}
      teamSize={params.teamSize ?? ""}
      sort={params.sort ?? "created_desc"}
      onCategory={(value) => update("category", value)}
      onMode={(value) => update("mode", value)}
      onStatus={(value) => update("status", value)}
      onTeamSize={(value) => update("teamSize", value)}
      onSort={(value) => update("sort", value)}
    />
  );
}
