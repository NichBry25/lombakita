/*
 * Tone separation: can a reader tell one semantic tone from another?
 *
 * NOTHING IN THIS REPO MEASURED THIS. `contrast-audit` measures each pairing against its OWN
 * ground, so a tone whose surface and ink are both perfectly readable passes — and `info` and
 * `success` both sat at hue 120.0°, 8.8pp apart in saturation and 2.8pp in lightness, with text
 * colours 0.9° apart. Contrast reported 107/107 clean the whole time. A refusal written as `info`
 * therefore renders as a verified payment, and on the money lane that is the difference between
 * "we have your transfer" and "we do not".
 *
 * The measure is CIEDE2000, not a WCAG ratio. A luminance ratio is the wrong instrument here by
 * construction: two colours of the same lightness and different hue have a ratio near 1:1 and are
 * instantly distinguishable, while two colours of the same hue and different lightness have a good
 * ratio and read as the same status. ΔE is the one that answers the question a reader is actually
 * asking.
 *
 * A pair passes if EITHER carrier separates it: the ground, or the ink. A warning and an error with
 * near-identical ink are still told apart when their grounds differ, and vice versa. Both numbers
 * are always reported, because which carrier is doing the work is what a fix has to know.
 *
 * The border is deliberately not counted. A `.status-badge` renders with `border: 0`, so a
 * separation carried only by a border would be a separation the badge does not have.
 */

/**
 * ΔE2000 below which two tones are treated as the same status.
 *
 * 10 is the conventional "clearly different colours, recognised from memory rather than compared
 * side by side", which is the reading task here: nobody sees the refusal pill and the verified pill
 * at once. 1 is a just-noticeable difference under laboratory conditions and 2–3 is noticeable on
 * inspection — both are far too generous for a status a reader identifies at a glance.
 */
export const MIN_TONE_SEPARATION = 10;

/**
 * The semantic tones and the tokens that paint them. Explicit rather than derived from token names,
 * because `neutral` is painted from the app's ordinary surface tokens rather than a
 * `--color-neutral-*` family, and a tone this table does not list is a tone nothing measures.
 */
export const TONES = {
  success: { surface: "--color-success-surface", text: "--color-success-text" },
  warning: { surface: "--color-warning-surface", text: "--color-warning-text" },
  error: { surface: "--color-error-surface", text: "--color-error-text" },
  info: { surface: "--color-info-surface", text: "--color-info-text" },
  neutral: { surface: "--color-inset", text: "--color-ink-soft" },
  disabled: { surface: "--color-disabled-surface", text: "--color-disabled-text" },
};

const THEMES = ["light", "dark"];

/**
 * Measures every tone pair in both themes and returns the ones too close to tell apart.
 *
 * Values are read as COMPUTED styles rather than out of the stylesheet source, so what is measured
 * is what the browser paints — including any override a later rule applied.
 */
export const toneSeparationFindings = async (page) =>
  page.evaluate(
    ({ tones, themes, threshold }) => {
      const root = document.documentElement;
      const previousTheme = root.dataset.theme;

      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      root.appendChild(probe);

      /** The token's painted colour as [r, g, b], resolved by the engine. */
      const rgbOf = (token) => {
        probe.style.color = "";
        probe.style.color = getComputedStyle(root).getPropertyValue(token).trim();
        const computed = getComputedStyle(probe).color;
        const parts = /rgba?\(([^)]+)\)/.exec(computed);
        if (!parts) return null;
        return parts[1]
          .split(/[,/]+/)
          .slice(0, 3)
          .map((n) => Number.parseFloat(n));
      };

      const toLab = ([r, g, b]) => {
        const linear = (channel) => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
        const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
        const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
        const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / 1.08883;
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const [fx, fy, fz] = [f(x), f(y), f(z)];
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
      };

      const deltaE2000 = ([l1, a1, b1], [l2, a2, b2]) => {
        const rad = Math.PI / 180;
        const c1 = Math.hypot(a1, b1);
        const c2 = Math.hypot(a2, b2);
        const cBar = (c1 + c2) / 2;
        const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
        const a1p = (1 + g) * a1;
        const a2p = (1 + g) * a2;
        const c1p = Math.hypot(a1p, b1);
        const c2p = Math.hypot(a2p, b2);
        const hue = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
        const h1p = hue(a1p, b1);
        const h2p = hue(a2p, b2);
        const dLp = l2 - l1;
        const dCp = c2p - c1p;
        let dhp = 0;
        if (c1p * c2p !== 0) {
          dhp = h2p - h1p;
          if (dhp > 180) dhp -= 360;
          else if (dhp < -180) dhp += 360;
        }
        const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2);
        const lBar = (l1 + l2) / 2;
        const cBarP = (c1p + c2p) / 2;
        let hBarP = h1p + h2p;
        if (c1p * c2p !== 0) {
          if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
          else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
          else hBarP = (h1p + h2p - 360) / 2;
        }
        const t =
          1 -
          0.17 * Math.cos((hBarP - 30) * rad) +
          0.24 * Math.cos(2 * hBarP * rad) +
          0.32 * Math.cos((3 * hBarP + 6) * rad) -
          0.2 * Math.cos((4 * hBarP - 63) * rad);
        const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
        const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
        const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
        const sC = 1 + 0.045 * cBarP;
        const sH = 1 + 0.015 * cBarP * t;
        const rT = -rC * Math.sin(2 * dTheta * rad);
        return Math.sqrt(
          (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
        );
      };

      const round = (n) => Math.round(n * 100) / 100;
      const names = Object.keys(tones);
      const findings = [];

      for (const theme of themes) {
        root.dataset.theme = theme;
        const painted = {};
        for (const name of names) {
          painted[name] = {
            surface: rgbOf(tones[name].surface),
            text: rgbOf(tones[name].text),
          };
        }
        for (let i = 0; i < names.length; i += 1) {
          for (let j = i + 1; j < names.length; j += 1) {
            const a = names[i];
            const b = names[j];
            if (!painted[a].surface || !painted[b].surface) continue;
            const ground = deltaE2000(toLab(painted[a].surface), toLab(painted[b].surface));
            const text = deltaE2000(toLab(painted[a].text), toLab(painted[b].text));
            const separation = Math.max(ground, text);
            if (separation >= threshold) continue;
            findings.push({
              theme,
              a,
              b,
              groundDeltaE: round(ground),
              textDeltaE: round(text),
              separation: round(separation),
              need: threshold,
              detail:
                ground >= text
                  ? "the grounds carry what separation there is; the ink does not"
                  : "the ink carries what separation there is; the grounds do not",
            });
          }
        }
      }

      probe.remove();
      if (previousTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = previousTheme;
      return findings;
    },
    { tones: TONES, themes: THEMES, threshold: MIN_TONE_SEPARATION },
  );
