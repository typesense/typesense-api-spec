import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REMOTE_FETCH_ATTEMPTS = 4;
const remoteFileCache = new Map<string, Promise<string>>();

export async function readTextFile(filePath: string): Promise<string> {
  if (!filePath.startsWith("https://")) {
    return readFile(filePath, "utf8");
  }

  // Routes, constants and symbols all read some of the same files.
  let cached = remoteFileCache.get(filePath);
  if (cached === undefined) {
    cached = fetchRemoteText(filePath);
    remoteFileCache.set(filePath, cached);
    cached.catch(() => remoteFileCache.delete(filePath));
  }
  return cached;
}

async function fetchRemoteText(url: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    let failure: string;
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "typesense-api-extractor",
          Accept: "text/plain",
        },
      });
      if (response.ok) {
        return await response.text();
      }
      failure = `${response.status} ${response.statusText}`;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Could not read remote file ${url}: ${failure}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Could not read remote file")) {
        throw error;
      }
      failure = error instanceof Error ? error.message : String(error);
    }

    if (attempt >= REMOTE_FETCH_ATTEMPTS) {
      throw new Error(`Could not read remote file ${url} after ${attempt} attempts: ${failure}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
}

export async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}
