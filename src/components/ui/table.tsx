"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { joinClassNames } from "./class-names";
import { Icon } from "./icon";
import { Spinner } from "./spinner";

// name is the first column and takes the title role in a stacked card. text is short plain text.
// long is a description that clamps to two lines. wrap is a reason that shows in full.
export type TableColumnKind =
  | "name"
  | "text"
  | "long"
  | "wrap"
  | "number"
  | "date"
  | "pill"
  | "control";

export type TableColumn = {
  key: string;
  header: string;
  kind?: TableColumnKind;
  // The header of a column that holds only controls is empty to the eye and read out to a screen
  // reader.
  hideHeader?: boolean;
};

export type TableRowData = {
  key: string;
  // A cell with no content shows the empty mark, except in a control column where it stays empty.
  cells: Record<string, ReactNode>;
  // The detail band under the row while it is open. A TableExpandToggle in one of the cells opens it.
  band?: ReactNode;
  // Set `open` and `onOpenChange` together when the page has to know that the row opened, for
  // example to load the band first.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type TableProps = {
  // Names the scroll region (or the table when it is flat).
  label: string;
  columns: readonly TableColumn[];
  rows: readonly TableRowData[];
  // Below 760 px each row becomes a card. For tables whose rows hold controls.
  stacked?: boolean;
  // A table inside a detail band: no frame, no header fill.
  flat?: boolean;
};

type RowControl = {
  isOpen: boolean;
  toggle: () => void;
  bandId: string;
};

const RowContext = createContext<RowControl | null>(null);

const isEmptyContent = (content: ReactNode): boolean =>
  content === null || content === undefined || content === false || content === "";

// The frame shows an edge fade while more columns wait on the right and a line on the sticky
// column after the first scroll. Both are written straight to the frame, so scrolling re-renders
// nothing.
function useScrollEdgeCues(
  frameRef: RefObject<HTMLDivElement | null>,
  regionRef: RefObject<HTMLDivElement | null>,
) {
  const updateEdgeCues = useCallback(() => {
    const frame = frameRef.current;
    const region = regionRef.current;
    if (!frame || !region) return;
    const hasScrolled = region.scrollLeft > 0;
    const hasMoreToTheRight = region.scrollLeft + region.clientWidth < region.scrollWidth - 1;
    frame.dataset.scrolled = String(hasScrolled);
    frame.dataset.more = String(hasMoreToTheRight);
  }, [frameRef, regionRef]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateEdgeCues);
    observer.observe(region);
    if (region.firstElementChild) observer.observe(region.firstElementChild);
    return () => observer.disconnect();
  }, [regionRef, updateEdgeCues]);

  return updateEdgeCues;
}

function TableEmptyMark() {
  return (
    <>
      <span aria-hidden="true" className="ui-table-empty">
        —
      </span>
      <span className="sr-only">Tidak ada</span>
    </>
  );
}

function TableCell({ column, content }: { column: TableColumn; content: ReactNode }) {
  const kind = column.kind ?? "text";
  const isEmpty = isEmptyContent(content);

  if (kind === "control") {
    return (
      <td data-kind={kind} data-label={column.header} data-empty={isEmpty ? "true" : undefined}>
        {isEmpty ? null : content}
      </td>
    );
  }

  const clampsText = kind === "long" && typeof content === "string";

  return (
    <td data-kind={kind} data-label={column.header} data-empty={isEmpty ? "true" : undefined}>
      <div className={joinClassNames("ui-table-value", clampsText && "ui-table-clamp")}>
        {isEmpty ? <TableEmptyMark /> : content}
      </div>
    </td>
  );
}

function TableRowView({ columns, row }: { columns: readonly TableColumn[]; row: TableRowData }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const bandId = useId();
  const isOpen = row.open ?? uncontrolledOpen;

  const toggle = () => {
    const next = !isOpen;
    if (row.open === undefined) setUncontrolledOpen(next);
    row.onOpenChange?.(next);
  };

  return (
    <RowContext.Provider value={{ isOpen, toggle, bandId }}>
      <tr data-open={isOpen ? "true" : undefined}>
        {columns.map((column) => (
          <TableCell key={column.key} column={column} content={row.cells[column.key]} />
        ))}
      </tr>
      {isOpen && row.band !== undefined ? (
        <tr id={bandId} data-band-row="true">
          <td colSpan={columns.length}>
            <div className="ui-table-band">{row.band}</div>
          </td>
        </tr>
      ) : null}
    </RowContext.Provider>
  );
}

/**
 * Tabel: the one table of the site. A page passes the columns and the rows, and the component
 * decides alignment, row height, the scroll cues and the phone layout. The scroll area is a
 * focusable region named after the table.
 */
export function Table({ label, columns, rows, stacked = false, flat = false }: TableProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const updateEdgeCues = useScrollEdgeCues(frameRef, regionRef);

  const table = (
    <table
      className="ui-table"
      data-flat={flat ? "true" : undefined}
      aria-label={flat ? label : undefined}
    >
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} scope="col" data-kind={column.kind ?? "text"}>
              {column.hideHeader ? <span className="sr-only">{column.header}</span> : column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableRowView key={row.key} columns={columns} row={row} />
        ))}
      </tbody>
    </table>
  );

  if (flat) return table;

  return (
    <div className="ui-table-frame" ref={frameRef} data-stacked={stacked ? "true" : undefined}>
      <div
        className="ui-table-scroll"
        ref={regionRef}
        role="region"
        tabIndex={0}
        aria-label={label}
        onScroll={updateEdgeCues}
      >
        {table}
      </div>
    </div>
  );
}

type TableExpandToggleProps = {
  // The words beside the chevron: "Lihat data", or the count of a team row.
  children: ReactNode;
  // Names what opens when the visible words are not enough, such as "Daftar anggota Tim Cakrawala".
  label?: string;
  loading?: boolean;
};

/**
 * Opens the detail band of the row it sits in. The words stay the same when the row is open: the
 * chevron and aria-expanded carry the state.
 */
export function TableExpandToggle({ children, label, loading = false }: TableExpandToggleProps) {
  const row = useContext(RowContext);
  if (!row) throw new Error("TableExpandToggle must sit inside a Table row");

  return (
    <button
      type="button"
      className="ui-table-link"
      aria-expanded={row.isOpen}
      aria-controls={row.isOpen ? row.bandId : undefined}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={loading}
      onClick={row.toggle}
    >
      <span>{children}</span>
      {loading ? (
        <Spinner size="sm" />
      ) : (
        <Icon name="chevron-down" size="sm" className="ui-table-chevron" />
      )}
    </button>
  );
}

/**
 * The name of a row as a link. Pass an aria-label that starts with a verb and names the row, since
 * the row as a whole is not a link.
 */
export function TableNameLink({ className, ...linkProps }: ComponentProps<typeof Link>) {
  return <Link {...linkProps} className={joinClassNames("ui-table-link", className)} />;
}

// Text that clamps to two lines. A string in a long column clamps by itself, so this is for
// content that is built from several parts.
export function TableClamp({ children }: { children: ReactNode }) {
  return <span className="ui-table-clamp">{children}</span>;
}

// Every stored key with its value, for a detail band.
export function TableDataList({
  entries,
}: {
  entries: ReadonlyArray<{ key: string; value: string }>;
}) {
  if (entries.length === 0) {
    return (
      <p className="ui-table-band-empty">
        <TableEmptyMark />
      </p>
    );
  }

  return (
    <dl className="ui-table-data-list">
      {entries.map((entry) => (
        <div key={entry.key}>
          <dt>{entry.key}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
