"use client";

import { useEffect, useState } from "react";
import {
  EmptyState,
  Skeleton,
  Table,
  TableNameLink,
  type TableColumn,
  type TableRowData,
} from "@/components/ui";
import { useToast } from "@/components/ui/primitives";
import { LocalDate } from "@/components/ui/local-date";

// One account on the staff domain watch as the watch route answers it. JSON carries the dates as
// ISO strings.
export type HostTrustWatchItem = {
  userId: string;
  name: string;
  signInEmail: string;
  organizationEmail: string;
  domain: string;
  trustedSince: string;
  watchEndsAt: string;
};

type WatchState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; items: HostTrustWatchItem[] };

const WATCH_URL = "/api/platform-ops/host-trust-watch";
const MODERATION_URL = "/admin/moderation";

const WATCH_HEADING = "Pantauan domain";
const WATCH_DESCRIPTION =
  "Akun yang menjadi tepercaya lewat domain organisasi yang dalam 90 hari terakhir memiliki penyelenggara yang status tepercayanya dicabut. Akun ini tetap langsung tayang. Periksa bila perlu.";
const WATCH_EMPTY_TITLE = "Pantauan sudah bersih";
const WATCH_EMPTY_DESCRIPTION = "Tidak ada akun baru di domain yang sedang dipantau.";
const WATCH_FAILED_MESSAGE = "Daftar pantauan belum dapat dimuat. Muat ulang halaman.";
const WATCH_FAILED_TITLE = "Daftar pantauan belum dapat dimuat";
const WATCH_FAILED_DESCRIPTION = "Muat ulang halaman.";
const WATCH_LOADING_LABEL = "Memuat pantauan domain";
const MODERATION_LINK_LABEL = "Buka di konsol moderasi";

const WATCH_COLUMNS: readonly TableColumn[] = [
  { key: "name", header: "Nama", kind: "name" },
  { key: "signInEmail", header: "Email akun", kind: "text" },
  { key: "organizationEmail", header: "Email organisasi", kind: "text" },
  { key: "domain", header: "Domain", kind: "text" },
  { key: "trustedSince", header: "Tepercaya sejak", kind: "date" },
  { key: "watchEndsAt", header: "Pantauan berakhir", kind: "date" },
  { key: "moderation", header: MODERATION_LINK_LABEL, kind: "control", hideHeader: true },
];

// Reads the watch, or answers null when the route refuses or the connection fails.
const fetchWatchList = async (): Promise<HostTrustWatchItem[] | null> => {
  try {
    const response = await fetch(WATCH_URL);
    if (!response.ok) return null;
    const payload = (await response.json()) as { watchList: HostTrustWatchItem[] };
    return payload.watchList;
  } catch {
    return null;
  }
};

const watchStateOf = (items: HostTrustWatchItem[] | null): WatchState => {
  if (items === null) return { status: "failed" };
  return { status: "ready", items };
};

// The moderation console opens an account from its sign-in email, and staff act on it there.
const moderationHrefOf = (item: HostTrustWatchItem): string =>
  `${MODERATION_URL}?email=${encodeURIComponent(item.signInEmail)}`;

const watchRowOf = (item: HostTrustWatchItem): TableRowData => ({
  key: item.userId,
  cells: {
    name: item.name,
    signInEmail: item.signInEmail,
    organizationEmail: item.organizationEmail,
    domain: item.domain,
    trustedSince: <LocalDate value={item.trustedSince} format="shortDateTime" />,
    watchEndsAt: <LocalDate value={item.watchEndsAt} format="shortDate" />,
    moderation: (
      <TableNameLink
        href={moderationHrefOf(item)}
        aria-label={`${MODERATION_LINK_LABEL}: ${item.name}`}
      >
        {MODERATION_LINK_LABEL}
      </TableNameLink>
    ),
  },
});

function WatchListBody({ state }: { state: WatchState }) {
  if (state.status === "loading") {
    return (
      <div className="stack-sm" role="status" aria-busy="true" aria-label={WATCH_LOADING_LABEL}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <EmptyState
        kind="not-found"
        size="compact"
        title={WATCH_FAILED_TITLE}
        description={WATCH_FAILED_DESCRIPTION}
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        kind="queue-clear"
        size="compact"
        title={WATCH_EMPTY_TITLE}
        description={WATCH_EMPTY_DESCRIPTION}
      />
    );
  }
  return (
    <Table
      label={WATCH_HEADING}
      columns={WATCH_COLUMNS}
      rows={state.items.map(watchRowOf)}
      stacked
    />
  );
}

// The staff watch of the 90 days after a trust removal on an organization domain: the accounts
// newly trusted there, read in the browser through the watch route, whose role gate guards the
// data.
export function HostTrustWatchList() {
  const { addToast } = useToast();
  const [state, setState] = useState<WatchState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void fetchWatchList().then((items) => {
      if (!active) return;
      if (items === null) addToast({ type: "error", message: WATCH_FAILED_MESSAGE });
      setState(watchStateOf(items));
    });
    return () => {
      active = false;
    };
  }, [addToast]);

  return (
    <section className="content-section">
      <div className="section-heading">
        <div>
          <h2>{WATCH_HEADING}</h2>
          <p className="muted-copy">{WATCH_DESCRIPTION}</p>
        </div>
      </div>
      <WatchListBody state={state} />
    </section>
  );
}
