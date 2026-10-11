import { requireGreenBeforeProbing, runProbes, substituteOnce } from "../guard-probe.mjs";
import { fails } from "./detectors.mjs";

const TEST = "src/app/operator-page-guards.test.tsx";
const TRIPWIRE = "src/app/page-guards.test.ts";
const PAGES = [
  {
    path: "/admin/featured",
    file: "src/app/admin/featured/page.tsx",
    role: "platform_ops",
    callbackPath: "/admin/featured",
    readerTail: "      desc(competitions.createdAt),\n    );\n",
  },
  {
    path: "/admin/fee-rules",
    file: "src/app/admin/fee-rules/page.tsx",
    role: "platform_ops",
    callbackPath: "/admin/fee-rules",
    readerTail: "  const rules = await listFeeRules();\n",
  },
  {
    path: "/admin/payments",
    file: "src/app/admin/payments/page.tsx",
    role: "platform_ops",
    callbackPath: "/admin/payments",
    readerTail: "    loadOpsBarredProofs(),\n  ]);\n",
  },
  {
    path: "/finance/payments",
    file: "src/app/finance/payments/page.tsx",
    role: "finance_ops",
    callbackPath: "/finance/payments",
    readerTail: "  const payments = await loadDisputePayments();\n",
  },
  {
    path: "/finance/payments/[paymentId]",
    file: "src/app/finance/payments/[paymentId]/page.tsx",
    role: "finance_ops",
    callbackPath: "/finance/payments",
    readerTail: "  const detail = await loadDisputePaymentDetail(paymentId);\n",
  },
];

export const probes = PAGES.flatMap((page) => {
  const guard = `  await requireRolePage("${page.role}", { callbackPath: "${page.callbackPath}" });\n`;
  const escapedPath = page.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reached = new RegExp(
    `× .*operator page ['"]${escapedPath}['"] > refuses before reading data when the role guard redirects`,
  );
  const detect = async () => fails("npx", ["vitest", "run", TEST, TRIPWIRE], reached);
  return [
    {
      name: `${page.path}: page role guard REMOVED`,
      klass: "C",
      harmfulMove: "calling cross-tenant readers without the page's authorization gate",
      files: [page.file],
      appliedMarkers: ["  void requireRolePage;"],
      mutate: () => substituteOnce(page.file, guard, "  void requireRolePage;\n"),
      detect,
    },
    {
      name: `${page.path}: page role guard MOVED after first reader`,
      klass: "C",
      harmfulMove: "calling cross-tenant readers before the page's authorization gate refuses",
      files: [page.file],
      appliedMarkers: [page.readerTail + guard],
      mutate: () => {
        substituteOnce(page.file, guard, "");
        substituteOnce(page.file, page.readerTail, page.readerTail + guard);
      },
      detect,
    },
  ];
});

if (import.meta.url === `file://${process.argv[1]}`) {
  requireGreenBeforeProbing("operator-page-guards", [["npx", ["vitest", "run", TEST, TRIPWIRE]]]);
  await runProbes(probes);
}
