import { Octokit } from "octokit";

const GITHUB_OWNER = "typesense" as const;
const GITHUB_REPO = "typesense" as const;
const GITHUB_RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}` as const;
const GITHUB_WEB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}` as const;
const GITHUB_API_VERSION = "2022-11-28" as const;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

// Unauthenticated requests share a 60/hour per-IP quota, which CI runners
// exhaust quickly; set GITHUB_TOKEN to use the authenticated quota.
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
      retryCount < 1 && retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS,
    onSecondaryRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) =>
      retryCount < 1 && retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS,
  },
});

export function resolveSourcePath(rootDir: string, filePath: string): string {
  const normalizedRootDir = normalizeRepoPath(rootDir);
  const normalizedFilePath = normalizeRepoPath(filePath);

  if (normalizedFilePath.length === 0) {
    throw new Error("Source file path cannot be empty.");
  }

  if (normalizedFilePath.startsWith("http://") || normalizedFilePath.startsWith("https://")) {
    return normalizedFilePath;
  }

  if (normalizedRootDir.length === 0) {
    return normalizedFilePath;
  }

  return normalizeRepoPath(`${normalizedRootDir}/${normalizedFilePath}`);
}

export function resolveRawGithubUrl(sourceBranch: string, sourcePath: string): string {
  const normalizedSourcePath = normalizeRepoPath(sourcePath);
  if (normalizedSourcePath.length === 0) {
    throw new Error("Source path cannot be empty.");
  }
  return `${GITHUB_RAW_BASE_URL}/${sourceBranch}/${normalizedSourcePath}`;
}

const pinnedCommits = new Map<string, string>();

/**
 * Resolves the commit the branch points at, and reads the branch at that commit from
 * then on. A push during a run then can't mix two versions of the source, or move the
 * lines the output cites away from the commit it records.
 */
export async function pinSourceCommit(sourceBranch: string): Promise<string> {
  const commit = await resolveSourceCommit(sourceBranch);
  pinnedCommits.set(sourceBranch, commit);
  return commit;
}

/**
 * Where to fetch a raw source URL: at its branch's pinned commit, if any. URLs keep the
 * branch name in the output, so they don't all change with every upstream commit.
 */
export function resolveFetchUrl(url: string): string {
  for (const [branch, commit] of pinnedCommits) {
    const prefix = `${GITHUB_RAW_BASE_URL}/${branch}/`;
    if (url.startsWith(prefix)) {
      return `${GITHUB_RAW_BASE_URL}/${commit}/${url.slice(prefix.length)}`;
    }
  }
  return url;
}

/** The commit the source branch points at, so reports can link to exact source. */
async function resolveSourceCommit(sourceBranch: string): Promise<string> {
  const response = await octokit.rest.repos
    .getCommit({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      ref: sourceBranch,
      per_page: 1,
      headers: {
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not resolve ${GITHUB_OWNER}/${GITHUB_REPO}@${sourceBranch}: ${message}.${rateLimitHint()}`,
      );
    });
  return response.data.sha;
}

/** A link to a raw source file's line, pinned to a commit when one is known. */
export function githubBlobUrl(rawUrl: string, line: number, commit: string | undefined): string | undefined {
  if (!rawUrl.startsWith(`${GITHUB_RAW_BASE_URL}/`)) {
    return undefined;
  }
  const [ref, ...filePath] = rawUrl.slice(GITHUB_RAW_BASE_URL.length + 1).split("/");
  return `${GITHUB_WEB_URL}/blob/${commit ?? ref ?? ""}/${filePath.join("/")}#L${String(line)}`;
}

export function githubCommitRangeUrl(previousCommit: string, nextCommit: string): string {
  return `${GITHUB_WEB_URL}/compare/${previousCommit}...${nextCommit}`;
}

export function githubCommitUrl(commit: string): string {
  return `${GITHUB_WEB_URL}/commit/${commit}`;
}

function rateLimitHint(): string {
  return process.env.GITHUB_TOKEN === undefined ? " Set GITHUB_TOKEN to avoid the anonymous rate limit." : "";
}

const treeCache = new Map<string, Promise<readonly string[]>>();

/** Lists blob paths once per branch, so one extraction makes one API call. */
function listBranchFiles(sourceBranch: string): Promise<readonly string[]> {
  const ref = pinnedCommits.get(sourceBranch) ?? sourceBranch;
  let cached = treeCache.get(ref);
  if (cached === undefined) {
    cached = fetchBranchFiles(ref);
    treeCache.set(ref, cached);
    cached.catch(() => treeCache.delete(ref));
  }
  return cached;
}

async function fetchBranchFiles(sourceBranch: string): Promise<readonly string[]> {
  const response = await octokit.rest.git
    .getTree({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      tree_sha: sourceBranch,
      recursive: "1",
      headers: {
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not list ${GITHUB_OWNER}/${GITHUB_REPO}@${sourceBranch}: ${message}.${rateLimitHint()}`);
    });

  if (response.data.truncated === true) {
    throw new Error(`GitHub tree response for ${sourceBranch} was truncated.`);
  }

  return response.data.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((filePath): filePath is string => filePath !== undefined);
}

export async function listSourceFiles(
  sourceBranch: string,
  rootDir: string,
  extensions: readonly string[],
): Promise<readonly string[]> {
  const normalizedRootDir = normalizeRepoPath(rootDir);
  const rootPrefix = normalizedRootDir.length === 0 ? "" : `${normalizedRootDir}/`;

  return (await listBranchFiles(sourceBranch))
    .filter((filePath) => rootPrefix.length === 0 || filePath.startsWith(rootPrefix))
    .filter((filePath) => extensions.some((extension) => filePath.endsWith(extension)));
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
