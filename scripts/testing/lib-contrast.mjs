/*
 * The contrast measurement itself, extracted from contrast-audit.mjs so it can be pointed at a
 * synthetic fixture as well as at a real page.
 *
 * That matters because this function is the only thing standing between the app and a whole theme
 * rendering dark-on-dark: if a refactor silently breaks it, every page reports clean and the
 * pipeline says nothing. contrast-audit-selftest.mjs drives it against hand-computed pairings so
 * the auditor is itself audited.
 */

export const audit = async (page) =>
  page.evaluate(() => {
    const parse = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value ?? "");
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[,/]+/).map((n) => Number.parseFloat(n));
      return { r, g, b, a: Number.isFinite(a) ? a : 1 };
    };

    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });

    const luminance = ({ r, g, b }) => {
      const ch = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };

    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    // The painted background is whatever survives compositing every translucent layer from the
    // element up to the first fully opaque one. Walking only the nearest ancestor with a colour
    // gets a translucent glass panel wrong by exactly the amount that matters.
    const backgroundOf = (el) => {
      const layers = [];
      let approx = false;
      // A gradient whose stops are all one colour is a solid fill wearing a gradient's clothes.
      // The lime highlighter marker is painted this way, so reading only background-color would
      // measure its text against whatever the marker is covering and report 1:1 for a pairing
      // that is actually 8.37:1.
      const flatFill = (image) => {
        const stops = image.match(/rgba?\([^)]+\)/g);
        if (!stops || stops.length === 0) return null;
        return stops.every((s) => s === stops[0]) ? parse(stops[0]) : null;
      };

      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage && s.backgroundImage !== "none") {
          const flat = flatFill(s.backgroundImage);
          if (flat && flat.a > 0) {
            layers.push(flat);
            if (flat.a === 1) break;
          } else {
            approx = true;
          }
        }
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a === 1) break;
        }
        if (n === document.documentElement) break;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
      return { color: base, approx };
    };

    const describe = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    // The failing element is often a bare <span>; what identifies the bug is the surface it sits
    // on, which is two or three levels up.
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
        parts.unshift(describe(n));
      }
      return parts.join(" > ");
    };

    const hex = ({ r, g, b }) =>
      `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

    // The control a label points at, whether it wraps it or names it with `for`.
    const controlOf = (label) => {
      const inside = label.querySelector("input, select, textarea, button");
      if (inside) return inside;
      return label.htmlFor ? document.getElementById(label.htmlFor) : null;
    };

    const isDisabled = (el) =>
      el.disabled === true || el.getAttribute("aria-disabled") === "true";

    const isInactive = (el) => {
      if (el.closest(":disabled, [aria-disabled='true']")) return true;
      const label = el.closest("label");
      if (!label) return false;
      const control = controlOf(label);
      return control !== null && isDisabled(control);
    };

    const findings = new Map();
    for (const el of document.querySelectorAll("body *")) {
      // Only elements that own text directly — a wrapper inherits its child's problem and would
      // report the same failure once per nesting level.
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (!text) continue;

      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.opacity === "0") continue;
      if (el.closest(".sr-only, .pf-visually-hidden, [hidden]")) continue;
      // A skeleton block is deliberately a shape with no readable content.
      if (el.closest("[aria-busy='true']")) continue;
      // WCAG 1.4.3 exempts text in an inactive component, and the disabled tokens are muted on
      // purpose. Without this the disabled-CTA pattern reports on most of the app and buries the
      // findings that are real.
      //
      // `closest()` walks ANCESTORS, and the commonest inactive component in this app does not put
      // its text inside the disabled element: a checkbox row is `<label><input disabled>Teks</label>`,
      // where the label wraps the control rather than descending from it. The exemption missed every
      // one of those, so the disabled checkbox rows were reported as real findings. A label is
      // inactive when the control it labels is.
      if (isInactive(el)) continue;

      const fg = parse(s.color);
      if (!fg || fg.a === 0) continue;
      const { color: bg, approx } = backgroundOf(el);
      const painted = fg.a < 1 ? over(fg, bg) : fg;

      const size = Number.parseFloat(s.fontSize);
      const weight = Number.parseInt(s.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(painted, bg);
      if (got >= need) continue;

      const key = `${describe(el)}|${hex(painted)}|${hex(bg)}`;
      if (!findings.has(key)) {
        findings.set(key, {
          el: path(el),
          fg: hex(painted),
          bg: hex(bg),
          ratio: Math.round(got * 100) / 100,
          need,
          approx,
          size: Math.round(size),
          sample: text.slice(0, 40),
        });
      }
    }
    return [...findings.values()].sort((a, b) => a.ratio - b.ratio);
  });
