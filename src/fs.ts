import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readTextFile(filePath: string): Promise<string> {
  if (filePath.startsWith("https://")) {
    const response = await fetch(filePath, {
      headers: {
        "User-Agent": "typesense-api-extractor",
        Accept: "text/plain",
      },
    });
    if (!response.ok) {
      throw new Error(
        `Could not read remote file ${filePath}: ${response.status} ${response.statusText}`,
      );
    }
    return response.text();
  }

  return readFile(filePath, "utf8");
}

export async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

export async function listFilesRecursive(
  rootPath: string,
): Promise<readonly string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursive(fullPath);
      }
      return entry.isFile() ? [fullPath] : [];
    }),
  );

  return nestedFiles.flat();
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ?? fileStat.isDirectory();
  } catch {
    return false;
  }
}
