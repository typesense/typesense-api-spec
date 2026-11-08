const RAW_PREFIX = "https://raw.githubusercontent.com/typesense/typesense/";
const TREE_PATTERN = /^https:\/\/api\.github\.com\/repos\/typesense\/typesense\/git\/trees\/([^?]+)/;

export interface FakeRepo {
  /** Repo-relative paths returned by the tree API. */
  listFiles(branch: string): readonly string[] | Promise<readonly string[]>;
  /** File contents, or undefined to answer 404. */
  readFile(branch: string, path: string): string | undefined | Promise<string | undefined>;
}

/**
 * Replaces global fetch with a fake GitHub, so the real Octokit and retry code
 * still run. Returns the function that restores the original fetch.
 *
 * src/fs.ts caches remote files by URL for the life of the process, so give
 * each test its own branch name (see nextBranch).
 */
export function stubGithub(repo: FakeRepo): () => void {
  const original = globalThis.fetch;
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);

    const treeMatch = TREE_PATTERN.exec(url);
    if (treeMatch?.[1] !== undefined) {
      const files = await repo.listFiles(decodeURIComponent(treeMatch[1]));
      return Response.json({
        truncated: false,
        tree: files.map((path) => ({ path, type: "blob" })),
      });
    }

    if (url.startsWith(RAW_PREFIX)) {
      const rest = url.slice(RAW_PREFIX.length);
      const slash = rest.indexOf("/");
      const contents = await repo.readFile(rest.slice(0, slash), rest.slice(slash + 1));
      return contents === undefined ? new Response("missing", { status: 404 }) : new Response(contents);
    }

    throw new Error(`Unexpected network request in test: ${url}`);
  };
  globalThis.fetch = stub as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let branchCounter = 0;

export function nextBranch(): string {
  branchCounter += 1;
  return `test-branch-${branchCounter}`;
}

/** Serves one in-memory set of files; unknown paths read as empty files. */
export function inMemoryRepo(files: Readonly<Record<string, string>>): FakeRepo {
  return {
    listFiles: () => Object.keys(files),
    readFile: (_branch, path) => files[path] ?? "",
  };
}
