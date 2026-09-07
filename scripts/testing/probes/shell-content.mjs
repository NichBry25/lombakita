/*
 * Rule 36 probe for shell-content.mjs: it must go red when an indexable route stops serving its
 * content in the initial shell.
 *
 * WHY THIS PROBE IS NOT OPTIONAL. The check reads two numbers off a fetched page, and both of them
 * have a passing value for a page that is completely broken. A response whose body is entirely
 * inside a hidden streaming container still returns 200, still carries every word in its bytes,
 * and still renders perfectly in the browser anyone would open to check. The whole defect is
 * invisible to every ordinary way of looking at it, which is why it shipped on two routes and sat
 * there — and it is why a check that reports green here has to be shown capable of reporting
 * anything else.
 *
 * IT ALREADY EARNED ITS KEEP. The first run of this probe found the check's competition-detail
 * needle matching the `<title>` element, which `generateMetadata` puts in the head and which is
 * therefore in the shell of even a fully streaming page. The needle stayed green while that route
 * served its entire body from a hidden container. The needle now names a section heading.
 *
 * THE HARMFUL MOVE, named before the detector was chosen: a Suspense boundary is reintroduced
 * around an indexable route's body, so Next flushes the shell before the page renders and streams
 * the body into `<div hidden>` for a script to swap in. That is the shape a `loading.tsx` in the
 * segment produces, reproduced here in a file that git tracks — the harness restores from git, and
 * an added file has nothing to restore to.
 *
 * IT MUTATES THE DYNAMIC ROUTE ON PURPOSE. The same mutation against a statically prerendered page
 * proves nothing: the prerender resolves the boundary at build time and the output is fully
 * materialised, so the check stays green and the probe would report NOT PROVEN for a reason that
 * has nothing to do with the guard. Measured, not assumed.
 *
 * Class D — the instrument is read-only, so the detector is the content of its result: a specific
 * exit code, the failing route named, and the other six routes still passing (a check that failed
 * for everything would satisfy an exit-code assertion while measuring nothing).
 *
 * Runs only over committed work — the harness refuses if the listed file differs from HEAD.
 * Rebuilds and restarts nothing on port 3000: it serves the mutated build on its own port, and
 * rebuilds from the restored source at the end so the tree and `.next` agree again.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runProbes, substituteOnce } from "../guard-probe.mjs";
import { INDEXABLE_SHELL_ROUTES } from "../indexable-shell-routes.mjs";
import { refusedWhen } from "./detectors.mjs";

const DETAIL_PAGE = "src/app/competitions/[institutionSlug]/[slug]/page.tsx";
const TERMS_PAGE = "src/app/syarat-ketentuan/page.tsx";
const PROBE_PORT = 3100;
const PROBE_BASE = `http://localhost:${PROBE_PORT}`;
const STREAMED_ROUTE = "/competitions/seed-academy/seed-open";
const UNDECLARED_ROUTE = "/syarat-ketentuan";

// A build plus a boot. Generous, because a timeout here reports NOT PROVEN for a probe that was
// only slow, and that is a worse outcome than waiting.
const BUILD_BUDGET_MS = 600000;
const BOOT_BUDGET_MS = 120000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the mutated build answers, so the check never measures a server that is not up. */
const waitForServer = async () => {
  const deadline = Date.now() + BOOT_BUDGET_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PROBE_BASE}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 200 || response.status === 503) return true;
    } catch {
      // Not up yet. The deadline is the only exit.
    }
    await sleep(2000);
  }

  return false;
};

/**
 * Builds the mutated tree and serves it on its own port, runs the check against it, and stops.
 *
 * The server is killed in a `finally` so a throwing assertion cannot leave a process holding the
 * port — the next run would then measure the PREVIOUS run's build and report whatever that said.
 */
const measureMutatedBuild = async () => {
  execFileSync("npm", ["run", "build"], { stdio: "pipe", timeout: BUILD_BUDGET_MS });

  const server = spawn("npm", ["run", "start", "--", "--port", String(PROBE_PORT)], {
    stdio: "ignore",
    detached: true,
  });

  try {
    if (!(await waitForServer())) {
      throw new Error(`the mutated build never began serving on ${PROBE_BASE}`);
    }

    return spawnSync("node", ["scripts/testing/shell-content.mjs"], {
      encoding: "utf8",
      env: { ...process.env, BASE_URL: PROBE_BASE },
      timeout: BOOT_BUDGET_MS,
    });
  } finally {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      server.kill("SIGKILL");
    }
  }
};

/**
 * Upgrades "the check went red" to "the check went red for THIS route and nothing else".
 *
 * Without it, a check that had become red for everything — a bad BASE_URL, a server serving error
 * pages, a needle table gone stale — satisfies an exit-code assertion while measuring nothing, and
 * reports itself PROVEN. Six is the count of indexable routes the mutation does not touch.
 */
const OTHER_ROUTES = INDEXABLE_SHELL_ROUTES.length - 1;

const onlyTheMutatedRouteFailed = (result, verdict) => {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const stillPassing = output.split("\n").filter((line) => /^ {2}ok /.test(line)).length;

  if (stillPassing !== OTHER_ROUTES) {
    return {
      refused: false,
      evidence:
        `shell-content went red, but ${stillPassing} of the other routes passed rather than ` +
        `${OTHER_ROUTES}. It failed for something broader than the mutation, so this proves ` +
        `nothing about the guard.`,
    };
  }

  return {
    refused: true,
    evidence: `${verdict.evidence} — and the other ${OTHER_ROUTES} indexable routes still passed`,
  };
};

export const probes = [
  {
    name: "shell-content refuses a route whose body moved out of the initial shell",
    harmfulMove:
      "a Suspense boundary is reintroduced around an indexable route's body, so the shell flushes " +
      "before the page renders and the body streams into a hidden container",
    klass: "D",
    files: [DETAIL_PAGE],
    mutate: () => {
      substituteOnce(
        DETAIL_PAGE,
        'import type { Metadata } from "next";',
        'import type { Metadata } from "next";\nimport { Suspense } from "react";',
      );
      substituteOnce(
        DETAIL_PAGE,
        `export default async function CompetitionDetailPage({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {`,
        `export default function CompetitionDetailPage(props: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {
  return (
    <Suspense fallback={<p>Memuat detail kompetisi…</p>}>
      <StreamedCompetitionDetail {...props} />
    </Suspense>
  );
}

async function StreamedCompetitionDetail({
  params,
}: {
  params: Promise<{ institutionSlug: string; slug: string }>;
}) {`,
      );
    },
    appliedMarkers: ["<StreamedCompetitionDetail", 'import { Suspense } from "react";'],
    detect: async () => {
      const result = await measureMutatedBuild();

      // The route must be named, and it must be named as a SHELL failure. An exit code alone would
      // be satisfied by the check crashing, and `reached` alone by any route failing.
      const verdict = refusedWhen(result, {
        status: 1,
        reached: new RegExp(`FAIL ${STREAMED_ROUTE} keeps only`),
        label: "shell-content",
      });

      if (!verdict.refused) return verdict;

      return onlyTheMutatedRouteFailed(result, verdict);
    },
  },

  /*
   * THE SECOND FAILURE THE SAME PAGES CAN HAVE, and it is invisible to everything above: a page
   * that serves all of its content, scores a perfect shell ratio, and then tells the crawler not
   * to index it. Indexing is opt-in — the root layout withholds by default and each indexable page
   * opts back in — so a page can join `STATIC_INDEXABLE_PATHS`, be advertised in the sitemap, and
   * still serve `noindex, nofollow` because nobody declared it. Reproduced during review by adding
   * one such route: the sitemap listed it and the page refused it, and the four tests that fired
   * were all counts, which go green when someone updates the number.
   *
   * THE HARMFUL MOVE, named before the detector: an indexable page's own `robots` declaration is
   * dropped, so it inherits the layout's withholding default while remaining in the sitemap. The
   * mutation is made to a page git already tracks, because the harness restores from git and an
   * added file has nothing to restore to — the end state is identical either way.
   *
   * Class D — read-only instrument, so the detector is the content of its result: the exit code,
   * the route named as a ROBOTS failure specifically, and the other six routes still passing.
   */
  {
    name: "shell-content refuses an indexable route that serves a withholding robots directive",
    harmfulMove:
      "an indexable page's own robots declaration is dropped, so it inherits the layout's " +
      "noindex default while the sitemap goes on advertising it",
    klass: "D",
    files: [TERMS_PAGE],
    mutate: () => {
      substituteOnce(
        TERMS_PAGE,
        'import { INDEXABLE_ROBOTS } from "@/config/indexable-routes";\n',
        "",
      );
      substituteOnce(TERMS_PAGE, "  robots: INDEXABLE_ROBOTS,\n", "");
    },
    appliedMarkers: ["  description: DESCRIPTION,\n  alternates:"],
    detect: async () => {
      const result = await measureMutatedBuild();

      // Named as a ROBOTS failure, not merely named. This page's ratio and needle are untouched by
      // the mutation, so a bare `FAIL <route>` that matched any reason would pass while measuring
      // something else entirely.
      const verdict = refusedWhen(result, {
        status: 1,
        reached: new RegExp(`FAIL ${UNDECLARED_ROUTE} is advertised in the sitemap while serving`),
        label: "shell-content",
      });

      if (!verdict.refused) return verdict;

      return onlyTheMutatedRouteFailed(result, verdict);
    },
  },
];

// Importable as data (probe-coverage.test.ts reads the list), executed only when run directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runProbes(probes);

  // The harness restored the source; `.next` still holds the mutated build. Rebuilding here leaves
  // the tree and the build agreeing, so a later check cannot measure the mutation after the file
  // that caused it is gone — which is the trap TRUST-D16 names.
  execFileSync("npm", ["run", "build"], { stdio: "pipe", timeout: BUILD_BUDGET_MS });
  console.log("rebuilt from restored sources; .next matches HEAD again.");
}
