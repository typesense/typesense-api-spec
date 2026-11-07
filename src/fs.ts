import { mkdir, readFile, writeFile } from "node:fs/promises";
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
