/*
 * What a client with scripting disabled actually paints, and how much of the response it is.
 *
 * Extracted from server-render.mjs so that script and shell-content.mjs measure the same thing.
 * Two checks with two copies of this logic would eventually disagree about what "in the shell"
 * means, and the one that drifted would be the one nobody re-read.
 *
 * TWO THINGS ARE STRIPPED BEFORE ANYTHING IS MEASURED, and both are load-bearing. Each is a way a
 * response can carry content while a scripting-disabled reader still sees none of it.
 *
 *   <script> blocks. The React server-component payload is embedded in the document inside them,
 *   so a competition title appears in the bytes of a page that renders nothing at all.
 *
 *   <div hidden> containers. When a route segment has a `loading.tsx`, Next flushes the skeleton
 *   into the shell and streams the real content into `<div hidden id="S:0">`, which an inline
 *   script swaps into place. With scripting off the swap never happens: the skeleton is what stays
 *   on screen and the content stays hidden.
 */

/*
 * `hidden` as its own attribute, never the tail of another one.
 *
 * The earlier form of this pattern was `\bhidden\b`, and `-` is a word boundary, so it also matched
 * `aria-hidden` — the attribute every decorative element in this app carries. On the landing page
 * that stripped 29KB of ornamental artwork out of the measurement and reported a page whose
 * content was in the shell as though it were streaming. Requiring whitespace immediately before the
 * word excludes `aria-hidden` and `class="hidden"` alike; refusing a trailing letter or dash keeps
 * a future `hidden-until-found` from matching.
 */
const HIDDEN_CONTAINER_OPENER = /<div\b[^>]*\shidden(?![-\w])[^>]*>/i;

/**
 * Removes each `<div hidden ...>` and everything up to its matching close tag.
 *
 * Depth-counted rather than matched with a regex, because these containers hold whole page
 * subtrees full of nested divs and a non-greedy match would stop at the first `</div>` inside
 * them, leaving most of the streamed content in place and defeating the strip.
 */
export const stripHiddenContainers = (html) => {
  let out = html;

  for (;;) {
    const start = out.search(HIDDEN_CONTAINER_OPENER);
    if (start === -1) return out;

    const openTag = out.slice(start).match(HIDDEN_CONTAINER_OPENER)[0];
    let cursor = start + openTag.length;
    let depth = 1;

    while (depth > 0) {
      const nextOpen = out.indexOf("<div", cursor);
      const nextClose = out.indexOf("</div>", cursor);

      // An unbalanced document would otherwise spin here. Dropping the remainder is the
      // conservative move: it can only remove evidence, never invent it.
      if (nextClose === -1) return out.slice(0, start);

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + 4;
      } else {
        depth -= 1;
        cursor = nextClose + 6;
      }
    }

    out = out.slice(0, start) + out.slice(cursor);
  }
};

/** The document with its script payloads removed, which is everything a crawler could read. */
export const withoutScripts = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

/** What a scripting-disabled client paints: no script payloads, no hidden stream targets. */
export const renderedMarkupOf = (html) => stripHiddenContainers(withoutScripts(html));

/**
 * Fetches a page and reports both the bytes it sent and the bytes a crawler would paint.
 *
 * `shellRatio` is painted over readable: 1 when everything the response carries is in the initial
 * shell, and a small fraction when the content is behind a streaming boundary.
 */
export const measureShell = async (base, path) => {
  const response = await fetch(`${base}${path}`, {
    headers: { accept: "text/html" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}, so nothing could be measured`);
  }

  const html = await response.text();
  const readable = withoutScripts(html);
  const painted = stripHiddenContainers(readable);

  return {
    html,
    markup: painted,
    readableBytes: readable.length,
    paintedBytes: painted.length,
    shellRatio: readable.length === 0 ? 0 : painted.length / readable.length,
  };
};
