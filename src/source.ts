import { Octokit } from "octokit";

const GITHUB_OWNER = "typesense" as const;
const GITHUB_REPO = "typesense" as const;
const GITHUB_RAW_BASE_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}` as const;
const GITHUB_API_VERSION = "2022-11-28" as const;
const octokit = new Octokit();

export function resolveSourcePath(rootDir: string, filePath: string): string {
  const normalizedRootDir = normalizeRepoPath(rootDir);
  const normalizedFilePath = normalizeRepoPath(filePath);

  if (normalizedFilePath.length === 0) {
    throw new Error("Source file path cannot be empty.");
  }

  if (
    normalizedFilePath.startsWith("http://") ||
    normalizedFilePath.startsWith("https://")
  ) {
    return normalizedFilePath;
  }

  if (normalizedRootDir.length === 0) {
    return normalizedFilePath;
  }

  return normalizeRepoPath(`${normalizedRootDir}/${normalizedFilePath}`);
}

export function resolveRawGithubUrl(
  sourceBranch: string,
  sourcePath: string,
): string {
  const normalizedSourcePath = normalizeRepoPath(sourcePath);
  if (normalizedSourcePath.length === 0) {
    throw new Error("Source path cannot be empty.");
  }
  return `${GITHUB_RAW_BASE_URL}/${sourceBranch}/${normalizedSourcePath}`;
}

export async function listSourceFiles(
  sourceBranch: string,
  rootDir: string,
  extensions: readonly string[],
): Promise<readonly string[]> {
  const response = await octokit.rest.git.getTree({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    tree_sha: sourceBranch,
    recursive: "1",
    headers: {
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });

  if (response.data.truncated === true) {
    throw new Error(`GitHub tree response for ${sourceBranch} was truncated.`);
  }

  const normalizedRootDir = normalizeRepoPath(rootDir);
  const rootPrefix =
    normalizedRootDir.length === 0 ? "" : `${normalizedRootDir}/`;

  return response.data.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((filePath): filePath is string => filePath !== undefined)
    .filter(
      (filePath) => rootPrefix.length === 0 || filePath.startsWith(rootPrefix),
    )
    .filter((filePath) =>
      extensions.some((extension) => filePath.endsWith(extension)),
    );
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
