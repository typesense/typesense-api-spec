import { existsSync } from "node:fs";
import path from "node:path";
import type { FakeRepo } from "./fake-github.js";

/** The clones are gitignored, so tests that need them skip when they are absent. */
export const repoRoot = path.resolve(import.meta.dir, "../..");

export function clonePath(name: string): string {
  return path.join(repoRoot, "tmp", name);
}

export function hasClone(name: string): boolean {
  return existsSync(path.join(clonePath(name), "src/main/typesense_server.cpp"));
}

/** Whether the clone has this commit, so it can reproduce output extracted from it. */
export function hasCommit(name: string, commit: string): boolean {
  return (
    hasClone(name) && Bun.spawnSync(["git", "-C", clonePath(name), "cat-file", "-e", `${commit}^{commit}`]).success
  );
}

/** Answers GitHub requests from a local clone at one commit, whatever branch is requested. */
export function cloneRepo(name: string, ref = "HEAD"): FakeRepo {
  const root = clonePath(name);
  return {
    commit: async () => (await Bun.$`git -C ${root} rev-parse ${ref}`.text()).trim(),
    listFiles: async () => {
      const listing = await Bun.$`git -C ${root} ls-tree -r ${ref}`.text();
      return listing
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split("\t"))
        .filter(([meta]) => meta?.split(" ")[1] === "blob" && meta?.split(" ")[0] !== "120000")
        .map(([, filePath]) => filePath ?? "");
    },
    readFile: async (_ref, filePath) => {
      const result = await Bun.$`git -C ${root} show ${`${ref}:${filePath}`}`.quiet().nothrow();
      return result.exitCode === 0 ? result.text() : undefined;
    },
  };
}
