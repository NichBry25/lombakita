"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type TabItem = { id: string; label: string; panel: ReactNode };

export function Tabs({
  label,
  tabs,
  selectedId,
  queryKey,
}: {
  label: string;
  tabs: readonly TabItem[];
  selectedId: string;
  queryKey: string;
}) {
  const baseId = useId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [currentId, setCurrentId] = useState(selectedId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (tab: TabItem) => {
    setCurrentId(tab.id);
    const params = new URLSearchParams(searchParams.toString());
    params.set(queryKey, tab.id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectAndFocus = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    select(tab);
    tabRefs.current[index]?.focus();
  };

  const targetIndexOf = (key: string, index: number): number | null => {
    if (key === "ArrowRight") return (index + 1) % tabs.length;
    if (key === "ArrowLeft") return (index - 1 + tabs.length) % tabs.length;
    if (key === "Home") return 0;
    if (key === "End") return tabs.length - 1;
    return null;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targetIndex = targetIndexOf(event.key, index);
    if (targetIndex === null) return;
    event.preventDefault();
    selectAndFocus(targetIndex);
  };

  return (
    <div className="stack-md">
      <div role="tablist" aria-label={label} className="ui-tablist">
        {tabs.map((tab, index) => {
          const isSelected = tab.id === currentId;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              className="ui-tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => select(tab)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        const isSelected = tab.id === currentId;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${baseId}-panel-${tab.id}`}
            aria-labelledby={`${baseId}-tab-${tab.id}`}
            tabIndex={0}
            hidden={!isSelected}
          >
            {isSelected ? tab.panel : null}
          </div>
        );
      })}
    </div>
  );
}
