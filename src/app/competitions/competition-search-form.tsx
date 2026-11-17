"use client";

import { useRouter } from "next/navigation";
import { useTransition, type FormEvent } from "react";
import { Button, Icon } from "@/components/ui";
import { CARRIED_FILTERS, competitionsHref, type CompetitionSearchParams } from "./search-params";

/**
 * The listing's search box.
 *
 * It renders as a plain GET form pointed at `/competitions`, with a hidden input per active
 * filter, so a browser with scripting disabled submits it natively and lands on a server-rendered
 * result. That native path is the fallback, not the primary one: when scripting is available the
 * submit is intercepted and routed through a transition instead, which is what lets the button
 * report that the search is running. A native submit is a full document navigation and gives the
 * page no way to show anything at all while it is in flight.
 *
 * A search always returns to page one — the old page number belongs to the previous result set.
 */
export function CompetitionSearchForm({
  params,
  variant = "listing",
}: {
  params: CompetitionSearchParams;
  variant?: "listing" | "home";
}) {
  const router = useRouter();
  const [isSearching, startSearching] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const submitted = new FormData(event.currentTarget);
    const term = String(submitted.get("q") ?? "").trim();

    startSearching(() => {
      router.push(competitionsHref(params, { q: term || undefined, page: undefined }));
    });
  };

  const isHome = variant === "home";
  const fieldId = isHome ? "home-search" : "competition-search";

  const field = (
    <input
      id={fieldId}
      name="q"
      type="search"
      placeholder="Cari judul atau kata kunci…"
      // Keyed on the applied term so a navigation resets the box to what the server actually
      // searched for, while typing between submits stays untouched.
      key={params.q ?? ""}
      defaultValue={params.q ?? ""}
      aria-label="Cari kompetisi"
    />
  );

  const carriedFilterInputs = CARRIED_FILTERS.map((filter) =>
    params[filter] ? (
      <input key={filter} type="hidden" name={filter} value={params[filter]} />
    ) : null,
  );

  if (isHome) {
    return (
      <form
        className="glass-focus home-search-entry"
        role="search"
        action="/competitions"
        onSubmit={handleSubmit}
      >
        <span className="home-search-icon" aria-hidden="true">
          <Icon name="search" size="lg" />
        </span>
        <span className="home-search-copy">{field}</span>
        {carriedFilterInputs}
        <Button type="submit" variant="primary" size="lg" loading={isSearching}>
          Mulai mencari
          <Icon name="arrow-right" size="md" />
        </Button>
      </form>
    );
  }

  return (
    <form
      className="glass-focus listing-search"
      role="search"
      action="/competitions"
      onSubmit={handleSubmit}
    >
      <Icon name="search" size="lg" />
      <label className="sr-only" htmlFor={fieldId}>
        Cari kompetisi
      </label>
      {field}
      {carriedFilterInputs}
      <Button type="submit" variant="primary" size="lg" loading={isSearching}>
        Cari
      </Button>
    </form>
  );
}
