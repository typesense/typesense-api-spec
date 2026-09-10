import type { SyntaxNode } from "tree-sitter";
import { childForField, parseCpp } from "./cpp-ast.js";
import { CountingSemaphore } from "./concurrency.js";
import { readTextFile } from "./fs.js";
import { listSourceFiles, resolveRawGithubUrl } from "./source.js";

export async function loadStringConstants(
  rootDir: string,
  sourceBranch: string,
): Promise<ReadonlyMap<string, string>> {
  const candidateFiles = await listSourceFiles(sourceBranch, rootDir, [".h", ".hpp", ".cpp"]);
  const semaphore = new CountingSemaphore(8);
  const sourceTexts = await Promise.all(
    candidateFiles.map(async (filePath) => {
      await semaphore.acquire();
      try {
        return await readTextFile(resolveRawGithubUrl(sourceBranch, filePath));
      } finally {
        semaphore.release();
      }
    }),
  );

  const allEntries = sourceTexts.flatMap(scanConstants);
  return new Map(
    [...allEntries].reverse().map(({ name, value }): [string, string] => [name, value]),
  );
}

interface ConstantEntry {
  readonly name: string;
  readonly value: string;
}

interface ScanAccumulator {
  readonly pendingLines: readonly string[];
  readonly entries: readonly ConstantEntry[];
}

function scanConstants(sourceText: string): readonly ConstantEntry[] {
  return sourceText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .reduce<ScanAccumulator>(
      (acc, line) => scanConstantLine(line, acc),
      { pendingLines: [], entries: [] },
    ).entries;
}

function scanConstantLine(line: string, acc: ScanAccumulator): ScanAccumulator {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return { pendingLines: [], entries: acc.entries };
  }

  if (trimmedLine.startsWith("#define")) {
    const entry = parseDefineConstant(trimmedLine);
    return {
      pendingLines: [],
      entries: entry !== undefined ? [...acc.entries, entry] : acc.entries,
    };
  }

  const pendingLines = [...acc.pendingLines, trimmedLine];
  if (!trimmedLine.endsWith(";")) {
    return { pendingLines, entries: acc.entries };
  }

  const entry = parseDeclarationConstant(pendingLines.join(" "));
  return {
    pendingLines: [],
    entries: entry !== undefined ? [...acc.entries, entry] : acc.entries,
  };
}

function parseDefineConstant(sourceLine: string): ConstantEntry | undefined {
  const rootNode = parseCpp(`${sourceLine}\n`);
  const defineNode = rootNode.namedChildren.find(
    (child) => child.type === "preproc_def",
  );
  if (defineNode === undefined) {
    return undefined;
  }

  const nameNode = defineNode.namedChildren.find(
    (child) => child.type === "identifier",
  );
  const valueNode = childForField(defineNode, "value");
  const name = nameNode?.text;
  const value =
    valueNode === undefined ? undefined : extractStringLiteral(valueNode.text);
  if (name === undefined || value === undefined) {
    return undefined;
  }
  return { name, value };
}

function parseDeclarationConstant(sourceLine: string): ConstantEntry | undefined {
  const rootNode = parseCpp(`${sourceLine}\n`);
  const declarationNode = rootNode.namedChildren.find(
    (child) => child.type === "declaration",
  );
  if (declarationNode === undefined) {
    return undefined;
  }

  const initDeclaratorNode = childForField(declarationNode, "declarator");
  if (
    initDeclaratorNode === undefined ||
    initDeclaratorNode.type !== "init_declarator"
  ) {
    return undefined;
  }

  const declaratorNode = childForField(initDeclaratorNode, "declarator");
  const valueNode = childForField(initDeclaratorNode, "value");
  const name = extractDeclaratorName(declaratorNode);
  const value =
    valueNode === undefined ? undefined : extractStringLiteral(valueNode.text);
  if (name === undefined || value === undefined) {
    return undefined;
  }
  return { name, value };
}

function extractDeclaratorName(
  node: SyntaxNode | undefined,
): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (node.type === "identifier" || node.type === "field_identifier") {
    return node.text;
  }

  const nestedDeclarator = childForField(node, "declarator");
  if (nestedDeclarator !== undefined) {
    return extractDeclaratorName(nestedDeclarator);
  }

  for (const child of node.namedChildren) {
    const name = extractDeclaratorName(child);
    if (name !== undefined) {
      return name;
    }
  }

  return undefined;
}

function extractStringLiteral(value: string): string | undefined {
  const trimmedValue = value.trim();
  return trimmedValue.startsWith('"') && trimmedValue.endsWith('"')
    ? trimmedValue.slice(1, trimmedValue.length - 1)
    : undefined;
}

export function resolveConstantValue(
  token: string,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  const trimmedToken = token.trim();
  const literalValue = extractStringLiteral(trimmedToken);
  if (literalValue !== undefined) {
    return literalValue;
  }
  return constants.get(trimmedToken);
}
