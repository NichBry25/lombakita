"use client";

import { Icon } from "@/components/ui";
import { COMPETITION_CATEGORY_OPTIONS } from "@/lib/competitions/categories";
import { clearInterests, toggleInterest, useInterests } from "@/lib/discovery/discovery-store";

// "Other" is a bucket for what fits no arena, not something anyone picks as an interest.
const PICKABLE_CATEGORIES = COMPETITION_CATEGORY_OPTIONS.filter(
  (option) => option.value !== "other",
);

// The visitor names their arenas once and the homepage reorders around them: their arenas' rows
// move to the top and a "Untuk kamu" row appears. Each chip is a toggle button rather than a
// checkbox in a form, because nothing is submitted: a tap takes effect immediately.
export function InterestPicker({ catalogEmpty }: { catalogEmpty: boolean }) {
  const interests = useInterests();
  const pickedCount = interests.length;

  return (
    <div className="interest-picker" id="minat">
      <div className="interest-picker-copy">
        <h3>Tandai minatmu</h3>
        <p aria-live="polite">
          {pickedCount === 0
            ? "Pilih arena yang ingin kamu ikuti. Berandamu akan menyusun ulang barisnya untukmu."
            : catalogEmpty
              ? `${pickedCount} minat dipilih. Baris "Untuk kamu" muncul di atas begitu ada kompetisi yang cocok.`
              : `${pickedCount} minat dipilih. Baris "Untuk kamu" dan arena pilihanmu kini tampil lebih dulu.`}
        </p>
      </div>

      <ul className="interest-chip-list" aria-label="Minat kompetisi">
        {PICKABLE_CATEGORIES.map((option) => {
          const picked = interests.includes(option.value);
          return (
            <li key={option.value}>
              <button
                type="button"
                className="interest-chip"
                data-category={option.value}
                aria-pressed={picked}
                onClick={() => toggleInterest(option.value)}
              >
                {picked ? <Icon name="check" size="sm" /> : null}
                {option.label}
              </button>
            </li>
          );
        })}
      </ul>

      {pickedCount > 0 ? (
        <button type="button" className="shelf-text-action" onClick={clearInterests}>
          Reset minat
        </button>
      ) : null}
    </div>
  );
}
