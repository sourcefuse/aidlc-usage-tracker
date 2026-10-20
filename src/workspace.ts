// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Read-only, allow-listed access to an AI-DLC repository.
 *
 * This is the only module that reads the repository. It can reach exactly these paths
 * under the repository root, and nothing else:
 *
 *   aidlc/spaces/<space>/intents/intents.json
 *   aidlc/spaces/<space>/intents/audit/<file>.md
 *   aidlc/spaces/<space>/intents/<intent>/audit/<file>.md
 *   .aidlc-usage/team.json
 *
 * Safety rules:
 * - Paths are built from fixed segments plus directory entries matching SAFE_NAME, so no
 *   `..`, absolute or hidden names can occur; repository contents never supply a path.
 * - Every directory on the way is checked with lstat: symbolic links are never followed.
 * - Files are opened with O_NOFOLLOW, must be regular files, and are size-capped.
 * - Counts are capped so a hostile repository cannot exhaust memory.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LIMITS = {
  maxShardBytes: 32 * 1024 * 1024,
  maxJsonBytes: 2 * 1024 * 1024,
  maxShards: 20_000,
} as const;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SHARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,251}\.md$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface ShardFile {
  /** Repository-relative POSIX path, e.g. `aidlc/spaces/default/intents/x/audit/h.md`. */
  path: string;
  space: string;
  /** Intent directory name, or null for space-level shards. */
  intentDir: string | null;
  text: string;
}

/** Reads a whole regular file without following a final symlink, refusing files above `maxBytes`. */
export function readFileSafely(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.toString("utf8", 0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Canonical form of a path that may not exist yet: realpath of its nearest existing ancestor. */
function realpathOfNearestAncestor(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export class AidlcWorkspace {
  readonly root: string;
  readonly warnings: string[] = [];
  private shardCount = 0;

  private constructor(root: string) {
    this.root = root;
  }

  static open(repo: string): AidlcWorkspace {
    const root = realpathSync(resolve(repo));
    if (!lstatSync(root).isDirectory()) throw new Error(`Not a directory: ${repo}`);
    return new AidlcWorkspace(root);
  }

  /** True when `path` is the repository's `aidlc/` directory or lies inside it (symlinks resolved). */
  isInsideAidlcData(path: string): boolean {
    const rel = relative(join(this.root, "aidlc"), realpathOfNearestAncestor(path));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }

  hasAidlc(): boolean {
    return this.directory(["aidlc", "spaces"]) !== null;
  }

  spaces(): string[] {
    return this.entries(["aidlc", "spaces"], "directory", SAFE_NAME).filter(
      (space) => this.directory(["aidlc", "spaces", space, "intents"]) !== null,
    );
  }

  /** Parsed `intents.json` of a space, or null when absent or unreadable. */
  readRegistry(space: string): unknown {
    return this.readJson(["aidlc", "spaces", space, "intents", "intents.json"]);
  }

  /** Parsed `.aidlc-usage/team.json`, or undefined when the repository has none. */
  readDefaultRoster(): unknown {
    return this.file([".aidlc-usage", "team.json"]) === null ? undefined : this.readJson([".aidlc-usage", "team.json"]);
  }

  /** All audit shards of a space: space-level shards first, then per intent. */
  *shards(space: string): Generator<ShardFile> {
    const intents = ["aidlc", "spaces", space, "intents"];
    yield* this.shardsIn([...intents, "audit"], space, null);
    for (const intentDir of this.entries(intents, "directory", SAFE_NAME)) {
      if (intentDir !== "audit") yield* this.shardsIn([...intents, intentDir, "audit"], space, intentDir);
    }
  }

  private *shardsIn(segments: string[], space: string, intentDir: string | null): Generator<ShardFile> {
    for (const name of this.entries(segments, "file", SHARD_NAME)) {
      if (++this.shardCount > LIMITS.maxShards) throw new Error(`More than ${LIMITS.maxShards} audit files; aborting.`);
      const file = join(this.root, ...segments, name);
      try {
        yield {
          path: [...segments, name].join("/"),
          space,
          intentDir,
          text: readFileSafely(file, LIMITS.maxShardBytes),
        };
      } catch (error) {
        this.warnings.push(`Skipped ${[...segments, name].join("/")}: ${(error as Error).message}`);
      }
    }
  }

  private readJson(segments: string[]): unknown {
    const file = this.file(segments);
    if (!file) return null;
    try {
      return JSON.parse(readFileSafely(file, LIMITS.maxJsonBytes));
    } catch (error) {
      this.warnings.push(`Could not read ${segments.join("/")}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Absolute path of a real (non-symlink) directory reached through real directories only. */
  private directory(segments: string[]): string | null {
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        if (!lstatSync(current).isDirectory()) return null;
      } catch {
        return null;
      }
    }
    return current;
  }

  private file(segments: string[]): string | null {
    const parent = this.directory(segments.slice(0, -1));
    if (!parent) return null;
    const file = join(parent, segments[segments.length - 1]);
    try {
      return lstatSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  private entries(segments: string[], kind: "directory" | "file", pattern: RegExp): string[] {
    const dir = this.directory(segments);
    if (!dir) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => pattern.test(d.name) && (kind === "directory" ? d.isDirectory() : d.isFile()))
      .map((d) => d.name)
      .sort();
  }
}
