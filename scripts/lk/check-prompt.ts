/**
 * Fails an implementer prompt on the mechanical defects that a reviewer would otherwise find by hand.
 *
 * Run: node --import tsx scripts/lk/check-prompt.ts <path to a prompt file>
 *
 * Every finding is one line `FAIL <check id> line <n>: <what>`. The last line is
 * `check-prompt: <count> finding(s)` and exit 1, or `check-prompt: PASS` and exit 0, each followed
 * by `, templates: <n>, unclassified: <n>`. Templates are the path-like tokens that hold a
 * placeholder and so were not checked. Unclassified are the tokens with a slash that are not a
 * template, not a URL and do not start with a root entry, so no check read them.
 * A prompt file that is missing, empty or not given, a working directory without a package.json and
 * a prompt file outside the working directory are refused through `refuse` from ./models: one line
 * starting `LK REFUSED: ` on stderr, exit 1, nothing on stdout.
 *
 * The repository root is the current working directory. The slug is the folder name above the
 * prompt file. The checks read a path only when the prompt names it, and a finding prints the token
 * and the reason, never text from the file that the token points at.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LkRefusal, parseCliArgs, refuse } from "./models";

/**
 * What each check reads, by check id. A prompt shape that none of these classifies is a finding,
 * never a skip.
 */
export const SUBJECT = {
  routing: { prefixes: ["Implementer:", "Tier:", "Reviewers:"] },
  end: { lastLine: "END OF PROMPT" },
  dash: {
    characters: [
      ["—", "U+2014"],
      ["–", "U+2013"],
    ],
  },
  path: {
    newPathsPrefix: "New paths:",
    leadingTrim: /^[`'"[\](){}]+/,
    trailingTrim: /[`'"[\](){}.,;:]+$/,
    templateCharacters: /[<>*]/,
    urlMarker: "://",
  },
  line: {
    suffix: /:(\d+)(?:-(\d+))?$/,
    followingText: /^ ?(?:"([^"]*)"|`([^`]*)`)/,
  },
  commit: {
    hash: /^[0-9a-f]{7,40}$/,
    sha256: /^[0-9a-f]{64}$/,
    digit: /[0-9]/,
    letter: /[a-f]/,
  },
  words: {
    word: /\b(?:accepted|decided|ruled|debt)\b/gi,
    begin: "BEGIN RECORDED WORDS",
    end: "END RECORDED WORDS",
  },
} as const;

export type CheckId = keyof typeof SUBJECT;

export interface Finding {
  check: CheckId;
  line: number;
  message: string;
}

export interface PromptReport {
  findings: Finding[];
  templates: number;
  unclassified: number;
}

export interface PromptContext {
  root: string;
  docsRoot: string;
  slug: string;
  rootEntries: ReadonlySet<string>;
}

export const buildPromptContext = (root: string, slug: string): PromptContext => ({
  root,
  docsRoot: join(root, "docs"),
  slug,
  rootEntries: new Set(readdirSync(root)),
});

const finding = (check: CheckId, line: number, message: string): Finding => ({
  check,
  line,
  message,
});

const splitLines = (text: string): string[] => text.split(/\r?\n/);

interface NumberedLine {
  text: string;
  number: number;
}

const nonEmptyLines = (lines: string[]): NumberedLine[] =>
  lines.flatMap((text, index) => (text.trim() === "" ? [] : [{ text, number: index + 1 }]));

/** The last line of a file is its last non-empty line, so a trailing newline does not count. */
const lastLineNumberOf = (lines: string[]): number => {
  const nonEmpty = nonEmptyLines(lines);
  const last = nonEmpty[nonEmpty.length - 1];
  return last === undefined ? 0 : last.number;
};

interface RawToken {
  text: string;
  start: number;
  end: number;
}

const rawTokensOf = (line: string): RawToken[] =>
  [...line.matchAll(/\S+/g)].map((match) => {
    const start = match.index ?? 0;
    return { text: match[0], start, end: start + match[0].length };
  });

const cleanedToken = (text: string): string =>
  text.replace(SUBJECT.path.leadingTrim, "").replace(SUBJECT.path.trailingTrim, "");

const looksLikePath = (cleaned: string, context: PromptContext): boolean => {
  if (!cleaned.includes("/")) return false;
  if (cleaned.includes(SUBJECT.path.urlMarker)) return false;
  const firstSegment = cleaned.split("/")[0] ?? "";
  return context.rootEntries.has(firstSegment);
};

const isUnclassifiedSlashToken = (cleaned: string, context: PromptContext): boolean => {
  if (!cleaned.includes("/")) return false;
  if (cleaned.includes(SUBJECT.path.urlMarker)) return false;
  if (SUBJECT.path.templateCharacters.test(cleaned)) return false;
  return !looksLikePath(cleaned, context);
};

const countUnclassifiedSlashTokens = (lines: string[], context: PromptContext): number =>
  lines
    .flatMap((text) => rawTokensOf(text))
    .filter((raw) => isUnclassifiedSlashToken(cleanedToken(raw.text), context)).length;

interface CitedLines {
  first: number;
  last: number;
  text: string;
}

interface PathToken {
  line: number;
  path: string;
  isTemplate: boolean;
  isOnNewPathsLine: boolean;
  cited: CitedLines | undefined;
  textAfter: string;
}

const readCitedLines = (cleaned: string): { path: string; cited: CitedLines | undefined } => {
  const match = cleaned.match(SUBJECT.line.suffix);
  if (match === null) return { path: cleaned, cited: undefined };
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  return {
    path: cleaned.slice(0, match.index),
    cited: { first, last, text: match[0].slice(1) },
  };
};

const pathTokensOnLine = (text: string, number: number, context: PromptContext): PathToken[] =>
  rawTokensOf(text).flatMap((raw) => {
    const cleaned = cleanedToken(raw.text);
    if (!looksLikePath(cleaned, context)) return [];
    const { path, cited } = readCitedLines(cleaned);
    return [
      {
        line: number,
        path,
        isTemplate: SUBJECT.path.templateCharacters.test(cleaned),
        isOnNewPathsLine: text.startsWith(SUBJECT.path.newPathsPrefix),
        cited,
        textAfter: text.slice(raw.end),
      },
    ];
  });

const pathTokensOf = (lines: string[], context: PromptContext): PathToken[] =>
  lines.flatMap((text, index) => pathTokensOnLine(text, index + 1, context));

const isRegularFile = (absolutePath: string): boolean =>
  existsSync(absolutePath) && statSync(absolutePath).isFile();

const absolutePathOf = (token: PathToken, context: PromptContext): string =>
  join(context.root, token.path);

export const checkRouting = (lines: string[]): Finding[] => {
  const nonEmpty = nonEmptyLines(lines);
  return SUBJECT.routing.prefixes.flatMap((prefix, position) => {
    const found = nonEmpty[position];
    if (found === undefined) {
      const message = `non-empty line ${position + 1} must start with ${prefix}, found no such line`;
      return [finding("routing", lastLineNumberOf(lines), message)];
    }
    if (found.text.startsWith(prefix)) return [];
    return [
      finding("routing", found.number, `non-empty line ${position + 1} must start with ${prefix}`),
    ];
  });
};

export const checkEnd = (lines: string[]): Finding[] => {
  const nonEmpty = nonEmptyLines(lines);
  const last = nonEmpty[nonEmpty.length - 1];
  const expected = SUBJECT.end.lastLine;
  if (last === undefined)
    return [finding("end", 0, `the last non-empty line must be exactly ${expected}`)];
  if (last.text === expected) return [];
  return [finding("end", last.number, `the last non-empty line must be exactly ${expected}`)];
};

export const checkDash = (lines: string[]): Finding[] =>
  lines.flatMap((text, index) => {
    const names = SUBJECT.dash.characters
      .filter(([character]) => text.includes(character))
      .map(([, name]) => name);
    if (names.length === 0) return [];
    return [finding("dash", index + 1, `holds ${names.join(" and ")}`)];
  });

const isExemptFromExistence = (token: PathToken, context: PromptContext): boolean =>
  token.isOnNewPathsLine || token.path.startsWith(`.work/${context.slug}/`);

export const checkPath = (lines: string[], context: PromptContext): Finding[] =>
  pathTokensOf(lines, context).flatMap((token) => {
    if (token.isTemplate) return [];
    if (isExemptFromExistence(token, context)) return [];
    if (existsSync(absolutePathOf(token, context))) return [];
    return [finding("path", token.line, `${token.path} does not exist`)];
  });

const collapseSpaces = (text: string): string => text.replace(/ +/g, " ");

const describeLines = (cited: CitedLines): string =>
  cited.first === cited.last ? `line ${cited.first}` : `lines ${cited.first}-${cited.last}`;

const quotedTextAfter = (token: PathToken): string | undefined => {
  const match = token.textAfter.match(SUBJECT.line.followingText);
  if (match === null) return undefined;
  return match[1] ?? match[2];
};

const citationProblem = (
  token: PathToken,
  cited: CitedLines,
  context: PromptContext,
): string | undefined => {
  const file = absolutePathOf(token, context);
  if (!isRegularFile(file)) return `${token.path} is not an existing file`;
  const fileLines = splitLines(readFileSync(file, "utf8"));
  const lastLine = lastLineNumberOf(fileLines);
  if (cited.first === 0 || cited.last === 0) {
    return `${token.path}:${cited.text} holds line number 0, and lines start at 1`;
  }
  if (cited.last < cited.first) return `${token.path}:${cited.text} ends before it starts`;
  if (cited.first > lastLine || cited.last > lastLine) {
    return `${token.path}:${cited.text} is past line ${lastLine}, the last line of the file`;
  }
  const quoted = quotedTextAfter(token);
  if (quoted === undefined || quoted === "") return undefined;
  const citedText = fileLines.slice(cited.first - 1, cited.last).join("\n");
  if (collapseSpaces(citedText).includes(collapseSpaces(quoted))) return undefined;
  return `"${quoted}" is not in ${describeLines(cited)} of ${token.path}`;
};

export const checkLine = (lines: string[], context: PromptContext): Finding[] =>
  pathTokensOf(lines, context).flatMap((token) => {
    if (token.isTemplate || token.cited === undefined) return [];
    const problem = citationProblem(token, token.cited, context);
    return problem === undefined ? [] : [finding("line", token.line, problem)];
  });

const isHashLike = (candidate: string, shape: RegExp): boolean =>
  shape.test(candidate) &&
  SUBJECT.commit.digit.test(candidate) &&
  SUBJECT.commit.letter.test(candidate);

const afterLastAt = (cleaned: string): string => cleaned.slice(cleaned.lastIndexOf("@") + 1);

const gitHasCommit = (directory: string, hash: string): boolean => {
  try {
    execFileSync("git", ["-C", directory, "cat-file", "-e", `${hash}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const commitExistsInRootOrDocs = (hash: string, context: PromptContext): boolean =>
  [context.root, context.docsRoot].some(
    (directory) => existsSync(directory) && gitHasCommit(directory, hash),
  );

const sha256ProblemOnLine = (
  hash: string,
  lineTokens: PathToken[],
  context: PromptContext,
): string | undefined => {
  const existing = lineTokens.filter(
    (token) => !token.isTemplate && isRegularFile(absolutePathOf(token, context)),
  );
  const [only] = existing;
  if (only === undefined || existing.length !== 1) {
    return "a sha256 needs exactly one existing path on its line, so it cannot be classified";
  }
  const digest = createHash("sha256")
    .update(readFileSync(absolutePathOf(only, context)))
    .digest("hex");
  if (digest.startsWith(hash)) return undefined;
  return `the sha256 is not the sha256 of ${only.path}`;
};

/** The two ends of a token such as `a3bc75b..HEAD`, or undefined when the token is not a range. */
const rangeEndsOf = (candidate: string): [string, string] | undefined => {
  const parts = candidate.split("..");
  if (parts.length !== 2) return undefined;
  const [start, end] = parts;
  if (start === undefined || end === undefined) return undefined;
  if (!isHashLike(start, SUBJECT.commit.hash)) return undefined;
  if (end !== "HEAD" && !isHashLike(end, SUBJECT.commit.hash)) return undefined;
  return [start, end];
};

const commitHashesOf = (candidate: string): string[] => {
  const ends = rangeEndsOf(candidate);
  if (ends !== undefined) return ends.filter((end) => end !== "HEAD");
  return isHashLike(candidate, SUBJECT.commit.hash) ? [candidate] : [];
};

export const checkCommit = (lines: string[], context: PromptContext): Finding[] => {
  const pathTokens = pathTokensOf(lines, context);
  return lines.flatMap((text, index) => {
    const number = index + 1;
    const lineTokens = pathTokens.filter((token) => token.line === number);
    return rawTokensOf(text).flatMap((raw) => {
      const candidate = afterLastAt(cleanedToken(raw.text));
      if (isHashLike(candidate, SUBJECT.commit.sha256)) {
        const problem = sha256ProblemOnLine(candidate, lineTokens, context);
        return problem === undefined ? [] : [finding("commit", number, problem)];
      }
      return commitHashesOf(candidate)
        .filter((hash) => !commitExistsInRootOrDocs(hash, context))
        .map((hash) =>
          finding("commit", number, `${hash} is not a commit in the repository root or docs/`),
        );
    });
  });
};

const blankPathTokens = (text: string, context: PromptContext): string =>
  rawTokensOf(text).reduce((blanked, raw) => {
    if (!looksLikePath(cleanedToken(raw.text), context)) return blanked;
    return blanked.slice(0, raw.start) + " ".repeat(raw.text.length) + blanked.slice(raw.end);
  }, text);

const distinctWordsIn = (text: string): string[] => {
  const words = [...text.matchAll(SUBJECT.words.word)].map((match) => match[0].toLowerCase());
  return [...new Set(words)];
};

const opensWhileOpenMessage = (openedAtLine: number): string =>
  `${SUBJECT.words.begin} while the block opened at line ${openedAtLine} is still open`;

export const checkWords = (lines: string[], context: PromptContext): Finding[] => {
  const findings: Finding[] = [];
  let openedAtLine: number | undefined;
  lines.forEach((text, index) => {
    if (text === SUBJECT.words.begin) {
      if (openedAtLine === undefined) openedAtLine = index + 1;
      else findings.push(finding("words", index + 1, opensWhileOpenMessage(openedAtLine)));
      return;
    }
    if (text === SUBJECT.words.end) {
      if (openedAtLine === undefined) {
        findings.push(
          finding("words", index + 1, `${SUBJECT.words.end} has no ${SUBJECT.words.begin}`),
        );
      }
      openedAtLine = undefined;
      return;
    }
    if (openedAtLine !== undefined) return;
    const words = distinctWordsIn(blankPathTokens(text, context));
    if (words.length === 0) return;
    const quoted = words.map((word) => `"${word}"`).join(", ");
    findings.push(finding("words", index + 1, `${quoted} outside a ${SUBJECT.words.begin} block`));
  });
  if (openedAtLine !== undefined) {
    findings.push(
      finding("words", openedAtLine, `${SUBJECT.words.begin} has no ${SUBJECT.words.end}`),
    );
  }
  return findings;
};

export const checkPromptText = (text: string, context: PromptContext): PromptReport => {
  const lines = splitLines(text);
  const findings = [
    ...checkRouting(lines),
    ...checkEnd(lines),
    ...checkDash(lines),
    ...checkPath(lines, context),
    ...checkLine(lines, context),
    ...checkCommit(lines, context),
    ...checkWords(lines, context),
  ];
  findings.sort((left, right) => left.line - right.line);
  const templates = pathTokensOf(lines, context).filter((token) => token.isTemplate).length;
  const unclassified = countUnclassifiedSlashTokens(lines, context);
  return { findings, templates, unclassified };
};

export const reportLinesOf = (report: PromptReport): string[] => {
  const findingLines = report.findings.map(
    (item) => `FAIL ${item.check} line ${item.line}: ${item.message}`,
  );
  const verdict = report.findings.length === 0 ? "PASS" : `${report.findings.length} finding(s)`;
  const counts = `templates: ${report.templates}, unclassified: ${report.unclassified}`;
  return [...findingLines, `check-prompt: ${verdict}, ${counts}`];
};

const readPromptFile = (path: string): string => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return refuse(`cannot read the prompt at ${path}`);
  }
  if (text.trim() === "") refuse(`the prompt at ${path} is empty`);
  return text;
};

const promptPathFromArgs = (args: string[]): string => {
  const { positionals } = parseCliArgs(args, {});
  const [path] = positionals;
  if (path === undefined) return refuse("give the path of a prompt file");
  if (positionals.length > 1) refuse(`unexpected argument "${positionals[1]}"`);
  return path;
};

const requireRepositoryRoot = (root: string): void => {
  if (existsSync(join(root, "package.json"))) return;
  refuse(`the current directory ${root} holds no package.json, so it is not the repository root`);
};

const requirePromptInside = (root: string, path: string): void => {
  const fromRoot = relative(root, resolve(path));
  const isOutside = fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
  if (isOutside || isAbsolute(fromRoot)) {
    refuse(`the prompt at ${path} is not inside the current directory ${root}`);
  }
};

const main = (): void => {
  try {
    const root = process.cwd();
    requireRepositoryRoot(root);
    const path = promptPathFromArgs(process.argv.slice(2));
    requirePromptInside(root, path);
    const text = readPromptFile(path);
    const slug = basename(dirname(resolve(path)));
    const report = checkPromptText(text, buildPromptContext(root, slug));
    console.log(reportLinesOf(report).join("\n"));
    process.exitCode = report.findings.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof LkRefusal)) throw error;
    console.error(`LK REFUSED: ${error.message}`);
    process.exit(1);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
