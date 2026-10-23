/**
 * A snapshot of the protected paths of a repository and the difference between two snapshots.
 *
 * The snapshot records what is on disk and never what a command meant: for each path of the set its
 * kind, its permission bits, the sha256 of its bytes when it is a file and the target text when it
 * is a link. A link is recorded and never followed. A folder is recorded and then walked in sorted
 * order, so every file below it has an entry of its own. Nothing is capped, neither the files
 * walked nor the bytes hashed.
 *
 * A path that does not exist, or whose parent is a file, is absent. Any other read error is thrown,
 * because a path that cannot be read cannot be called unchanged.
 *
 * Paths are matched case-folded, as the protect-file hook matches them, so two paths that differ
 * only in case are one path.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

export type PathKind = "file" | "link" | "folder" | "absent";
export type ChangeKind = "added" | "removed" | "changed" | "kind changed";

export interface SnapshotEntry {
  /** Relative to the root. A path of the set keeps the spelling the set gives it, a slash included. */
  path: string;
  kind: PathKind;
  /** The permission bits; absent only for an absent path. */
  mode?: number;
  /** Set for a file. */
  sha256?: string;
  /** Set for a link. */
  target?: string;
}

export interface PathChange {
  path: string;
  change: ChangeKind;
}

/** A change with the kind that sits at its path now, or the kind a removed path had. Never written or printed. */
export interface KindedChange extends PathChange {
  kind: PathKind;
}

const PERMISSION_BITS = 0o7777;
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

const isMissingPath = (error: unknown): boolean =>
  MISSING_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? "");

// A trailing slash makes the system follow a link, and a link is recorded as itself.
export const withoutTrailingSlash = (path: string): string =>
  path.endsWith("/") ? path.slice(0, -1) : path;

const sha256Of = (absolute: string): string =>
  createHash("sha256").update(readFileSync(absolute)).digest("hex");

const readStats = (absolute: string): Stats | undefined => {
  try {
    return lstatSync(absolute);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
};

const entryAt = (root: string, path: string): SnapshotEntry => {
  const absolute = join(root, withoutTrailingSlash(path));
  const stats = readStats(absolute);
  if (stats === undefined) return { path, kind: "absent" };
  const mode = stats.mode & PERMISSION_BITS;
  if (stats.isSymbolicLink()) return { path, kind: "link", mode, target: readlinkSync(absolute) };
  if (stats.isDirectory()) return { path, kind: "folder", mode };
  if (stats.isFile()) return { path, kind: "file", mode, sha256: sha256Of(absolute) };
  throw new Error(`${path} is neither a file, a link nor a folder`);
};

const collectEntries = (root: string, path: string, into: SnapshotEntry[]): void => {
  const entry = entryAt(root, path);
  into.push(entry);
  if (entry.kind !== "folder") return;
  const folder = withoutTrailingSlash(path);
  const names = readdirSync(join(root, folder)).sort();
  for (const name of names) collectEntries(root, `${folder}/${name}`, into);
};

// Two entries under one folded path would leave one of them unseen by every comparison.
const indexByFoldedPath = (snapshot: readonly SnapshotEntry[]): Map<string, SnapshotEntry> => {
  const index = new Map<string, SnapshotEntry>();
  for (const entry of snapshot) {
    const key = entry.path.toLowerCase();
    const earlier = index.get(key);
    if (earlier !== undefined) {
      throw new Error(`${earlier.path} and ${entry.path} are one path once case is folded`);
    }
    index.set(key, entry);
  }
  return index;
};

export const snapshotProtectedPaths = (root: string, set: readonly string[]): SnapshotEntry[] => {
  const entries: SnapshotEntry[] = [];
  for (const path of set) collectEntries(root, path, entries);
  indexByFoldedPath(entries);
  return entries;
};

const isThere = (entry: SnapshotEntry | undefined): entry is SnapshotEntry =>
  entry !== undefined && entry.kind !== "absent";

const hasSameContent = (before: SnapshotEntry, after: SnapshotEntry): boolean =>
  before.mode === after.mode && before.sha256 === after.sha256 && before.target === after.target;

const changeBetween = (
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined,
): KindedChange | undefined => {
  if (isThere(before) && isThere(after)) {
    const { path, kind } = after;
    if (before.kind !== kind) return { path, change: "kind changed", kind };
    return hasSameContent(before, after) ? undefined : { path, change: "changed", kind };
  }
  if (isThere(after)) return { path: after.path, change: "added", kind: after.kind };
  if (isThere(before)) return { path: before.path, change: "removed", kind: before.kind };
  return undefined;
};

/** One entry per path that differs, spelled as the later snapshot spells it, or the earlier for a removed path. */
export const diffSnapshots = (
  before: readonly SnapshotEntry[],
  after: readonly SnapshotEntry[],
): KindedChange[] => {
  const earlier = indexByFoldedPath(before);
  const later = indexByFoldedPath(after);
  const paths = new Set([...earlier.keys(), ...later.keys()]);
  const changes: KindedChange[] = [];
  for (const path of paths) {
    const change = changeBetween(earlier.get(path), later.get(path));
    if (change !== undefined) changes.push(change);
  }
  return changes;
};
