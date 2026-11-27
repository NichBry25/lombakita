// @vitest-environment jsdom

// The staff domain watch, rendered inside the real UIPrimitivesProvider so the toasts are the real
// ones. fetch is the only stub: it answers in the shape the watch route answers.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UIPrimitivesProvider } from "@/components/ui/primitives";
import { HostTrustWatchList, type HostTrustWatchItem } from "./host-trust-watch-list";

const WATCH_URL = "/api/platform-ops/host-trust-watch";
const MODERATION_URL = "/admin/moderation";
const WATCH_DESCRIPTION =
  "Akun yang menjadi tepercaya lewat domain organisasi yang dalam 90 hari terakhir memiliki penyelenggara yang status tepercayanya dicabut. Akun ini tetap langsung tayang. Periksa bila perlu.";
const EMPTY_TITLE = "Pantauan sudah bersih";
const EMPTY_DESCRIPTION = "Tidak ada akun baru di domain yang sedang dipantau.";
const FAILED_MESSAGE = "Daftar pantauan belum dapat dimuat. Muat ulang halaman.";
const FAILED_TITLE = "Daftar pantauan belum dapat dimuat";
const FAILED_DESCRIPTION = "Muat ulang halaman.";
const LOADING_LABEL = "Memuat pantauan domain";
const LINK_LABEL = "Buka di konsol moderasi";

const citra: HostTrustWatchItem = {
  userId: "user_citra",
  name: "Citra Lestari",
  signInEmail: "citra.lokal@seed.lombakita.local",
  organizationEmail: "citra@acme.example",
  domain: "acme.example",
  trustedSince: "2026-11-20T03:00:00.000Z",
  watchEndsAt: "2027-02-10T03:00:00.000Z",
};

const andi: HostTrustWatchItem = {
  userId: "user_andi",
  name: "Andi Saputra",
  signInEmail: "andi.lokal@seed.lombakita.local",
  organizationEmail: "andi@lab.acme.example",
  domain: "acme.example",
  trustedSince: "2026-11-18T03:00:00.000Z",
  watchEndsAt: "2027-02-10T03:00:00.000Z",
};

type SentRequest = { url: string; method: string };

const sent: SentRequest[] = [];
let watchResponses: Array<() => Response | Promise<Response>> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(input), method: init?.method ?? "GET" });
  const next = watchResponses.shift();
  if (!next) throw new Error(`unexpected request: ${String(input)}`);
  return next();
});

vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  watchResponses = [];
});

const renderWatchList = () =>
  render(
    <UIPrimitivesProvider>
      <HostTrustWatchList />
    </UIPrimitivesProvider>,
  );

const toastOf = (text: string): Element | null =>
  screen.getByText(text).closest("[data-toast-type]");

const expectRowOf = (
  row: HTMLElement,
  item: HostTrustWatchItem,
  expectedSearch: string,
  trustedSince: string,
) => {
  expect(within(row).getByText(item.name)).toBeTruthy();
  expect(within(row).getByText(item.signInEmail)).toBeTruthy();
  expect(within(row).getByText(item.organizationEmail)).toBeTruthy();
  expect(within(row).getByText(item.domain)).toBeTruthy();
  const times = Array.from(row.querySelectorAll("time")).map((time) =>
    time.getAttribute("datetime"),
  );
  expect(times).toEqual([trustedSince, item.watchEndsAt]);
  const link = within(row).getByRole("link", { name: LINK_LABEL });
  expect(link.getAttribute("href")).toBe(`${MODERATION_URL}${expectedSearch}`);
};

const expectFailedBody = async () => {
  expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
  expect(toastOf(FAILED_MESSAGE)?.getAttribute("data-toast-type")).toBe("error");
  expect(screen.getByText(FAILED_DESCRIPTION)).toBeTruthy();
  expect(document.querySelector(".feedback")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
};

describe("the staff domain watch", () => {
  it("lists each newly trusted account with its emails, its domain, its dates and a link to the moderation console, in the order the route gives", async () => {
    watchResponses = [() => jsonResponse({ watchList: [citra, andi] })];
    renderWatchList();

    const region = await screen.findByRole("region", { name: "Pantauan domain" });
    expect(screen.getByRole("heading", { level: 2, name: "Pantauan domain" })).toBeTruthy();
    expect(screen.getByText(WATCH_DESCRIPTION)).toBeTruthy();
    const table = within(region).getByRole("table");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual([
      "Nama",
      "Email akun",
      "Email organisasi",
      "Domain",
      "Tepercaya sejak",
      "Pantauan berakhir",
      LINK_LABEL,
    ]);
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(bodyRows).toHaveLength(2);
    const [citraRow, andiRow] = bodyRows;
    if (!citraRow || !andiRow) throw new Error("the watch table must hold two body rows");
    expectRowOf(citraRow, citra, "?email=citra.lokal%40seed.lombakita.local", citra.trustedSince);
    expectRowOf(andiRow, andi, "?email=andi.lokal%40seed.lombakita.local", andi.trustedSince);
    expect(sent).toEqual([{ url: WATCH_URL, method: "GET" }]);
  });

  it("says no new account is on a watched domain when the list is empty", async () => {
    watchResponses = [() => jsonResponse({ watchList: [] })];
    renderWatchList();

    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText(EMPTY_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says the watch list could not load when the route refuses", async () => {
    watchResponses = [() => jsonResponse({ error: { code: "forbidden", message: "no" } }, 403)];
    renderWatchList();

    await expectFailedBody();
  });

  it("says the watch list could not load when the connection fails", async () => {
    watchResponses = [
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    renderWatchList();

    await expectFailedBody();
  });

  it("marks the loading watch list as waiting", () => {
    watchResponses = [() => new Promise<Response>(() => {})];
    renderWatchList();

    expect(screen.getByRole("status", { name: LOADING_LABEL }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
