import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Table,
  TableDataList,
  TableExpandToggle,
  TableNameLink,
  type TableColumn,
  type TableRowData,
} from "./table";

const columns: readonly TableColumn[] = [
  { key: "name", header: "Nama", kind: "name" },
  { key: "count", header: "Jumlah", kind: "number" },
  { key: "note", header: "Catatan", kind: "long" },
  { key: "actions", header: "Tindakan", kind: "control", hideHeader: true },
];

const buildRows = (): TableRowData[] => [
  {
    key: "a",
    cells: {
      name: "Andi",
      count: 3,
      note: "Catatan pendek",
      actions: <TableExpandToggle>Lihat data</TableExpandToggle>,
    },
    band: <p>Isi detail Andi</p>,
  },
  { key: "b", cells: { name: "Budi", count: null, note: null, actions: null } },
];

describe("Table", () => {
  it("names the scroll region after the table and lets the keyboard reach it", () => {
    render(<Table label="Peserta" columns={columns} rows={buildRows()} />);

    const region = screen.getByRole("region", { name: "Peserta" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getByRole("table")).toBeTruthy();
  });

  it("reads out the header of a control column and shows nothing for it", () => {
    render(<Table label="Peserta" columns={columns} rows={buildRows()} />);

    const header = screen.getByRole("columnheader", { name: "Tindakan" });
    expect(header.querySelector(".sr-only")?.textContent).toBe("Tindakan");
  });

  it("shows the empty mark with a screen reader word, and leaves an empty control cell empty", () => {
    render(<Table label="Peserta" columns={columns} rows={buildRows()} />);

    const budiRow = screen.getByRole("row", { name: /Budi/ });
    const cells = within(budiRow).getAllByRole("cell");
    expect(cells[1]?.textContent).toBe("—Tidak ada");
    expect(cells[2]?.textContent).toBe("—Tidak ada");
    expect(cells[3]?.textContent).toBe("");
    expect(cells[3]?.getAttribute("data-empty")).toBe("true");
  });

  it("marks the column kind on header and cells, and clamps a string in a long column", () => {
    const { container } = render(<Table label="Peserta" columns={columns} rows={buildRows()} />);

    expect(screen.getByRole("columnheader", { name: "Jumlah" }).getAttribute("data-kind")).toBe(
      "number",
    );
    expect(container.querySelector("td[data-kind='long'] .ui-table-clamp")).not.toBeNull();
  });

  it("does not clamp built content in a long column", () => {
    const rows: TableRowData[] = [
      { key: "a", cells: { name: "Andi", note: <strong>Tebal</strong> } },
    ];
    const { container } = render(<Table label="Peserta" columns={columns} rows={rows} />);

    expect(container.querySelector(".ui-table-clamp")).toBeNull();
  });

  it("opens the band under its row and keeps the same words while the chevron state changes", () => {
    render(<Table label="Peserta" columns={columns} rows={buildRows()} />);
    const toggle = screen.getByRole("button", { name: "Lihat data" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Isi detail Andi")).toBeNull();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Lihat data" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const band = screen.getByText("Isi detail Andi").closest("tr");
    expect(band?.id).toBe(toggle.getAttribute("aria-controls"));

    fireEvent.click(toggle);

    expect(screen.queryByText("Isi detail Andi")).toBeNull();
  });

  it("follows the page when the row is controlled and reports the request to open", () => {
    const onOpenChange = vi.fn();
    const rows: TableRowData[] = [
      {
        key: "a",
        open: false,
        onOpenChange,
        cells: { name: "Andi", actions: <TableExpandToggle>Lihat log</TableExpandToggle> },
        band: <p>Riwayat</p>,
      },
    ];
    render(<Table label="Institusi" columns={columns} rows={rows} />);

    fireEvent.click(screen.getByRole("button", { name: "Lihat log" }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("Riwayat")).toBeNull();
  });

  it("shows a waiting toggle that cannot be pressed", () => {
    const rows: TableRowData[] = [
      {
        key: "a",
        cells: {
          name: "Andi",
          actions: <TableExpandToggle loading>Lihat log</TableExpandToggle>,
        },
        band: <p>Riwayat</p>,
      },
    ];
    render(<Table label="Institusi" columns={columns} rows={rows} />);

    const toggle = screen.getByRole("button", { name: "Lihat log" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
  });

  it("names a toggle by its label when the words alone do not say what opens", () => {
    const rows: TableRowData[] = [
      {
        key: "a",
        cells: {
          name: "Tim Cakrawala",
          count: <TableExpandToggle label="Daftar anggota Tim Cakrawala">4</TableExpandToggle>,
        },
        band: <p>Anggota</p>,
      },
    ];
    render(<Table label="Peserta" columns={columns} rows={rows} />);

    expect(screen.getByRole("button", { name: "Daftar anggota Tim Cakrawala" })).toBeTruthy();
  });

  it("refuses a toggle that sits outside a table row", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TableExpandToggle>Lihat data</TableExpandToggle>)).toThrow(
      "TableExpandToggle must sit inside a Table row",
    );
    quiet.mockRestore();
  });

  it("marks a table of rows with controls as stacked below 760 px", () => {
    const { container } = render(
      <Table label="Tim" columns={columns} rows={buildRows()} stacked />,
    );

    expect(container.querySelector(".ui-table-frame")?.getAttribute("data-stacked")).toBe("true");
  });

  it("draws a flat table with its own name and no frame or region", () => {
    render(<Table flat label="Riwayat status Kampus" columns={columns} rows={buildRows()} />);

    expect(screen.getByRole("table", { name: "Riwayat status Kampus" })).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("tells the frame when the table has scrolled and when more columns wait on the right", () => {
    const { container } = render(<Table label="Peserta" columns={columns} rows={buildRows()} />);
    const frame = container.querySelector(".ui-table-frame") as HTMLElement;
    const region = screen.getByRole("region", { name: "Peserta" });
    Object.defineProperty(region, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(region, "scrollWidth", { configurable: true, value: 900 });

    region.scrollLeft = 120;
    fireEvent.scroll(region);
    expect(frame.dataset.scrolled).toBe("true");
    expect(frame.dataset.more).toBe("true");

    region.scrollLeft = 500;
    fireEvent.scroll(region);
    expect(frame.dataset.more).toBe("false");

    region.scrollLeft = 0;
    fireEvent.scroll(region);
    expect(frame.dataset.scrolled).toBe("false");
  });
});

describe("TableNameLink", () => {
  it("is a link whose name carries a verb and the row's name", () => {
    render(
      <TableNameLink href="/peserta/1" aria-label="Tinjau pendaftaran Andi Saputra">
        Andi Saputra
      </TableNameLink>,
    );

    const link = screen.getByRole("link", { name: "Tinjau pendaftaran Andi Saputra" });
    expect(link.getAttribute("href")).toBe("/peserta/1");
  });
});

describe("TableDataList", () => {
  it("lists every key with its whole value", () => {
    render(
      <TableDataList
        entries={[
          { key: "verdict", value: "reject" },
          { key: "note", value: "x".repeat(200) },
        ]}
      />,
    );

    expect(screen.getByText("verdict").tagName).toBe("DT");
    expect(screen.getByText("x".repeat(200)).tagName).toBe("DD");
  });

  it("shows the empty mark when nothing is stored", () => {
    render(<TableDataList entries={[]} />);

    expect(screen.getByText("Tidak ada")).toBeTruthy();
  });
});
