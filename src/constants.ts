import type { SyntaxNode } from "tree-sitter";
import { childForField, extractDeclaratorName, extractStringLiteral, parseCpp } from "./cpp-ast.js";
import { readTextFile } from "./fs.js";
import { listSourceFiles, resolveRawGithubUrl, resolveSourcePath } from "./source.js";

export async function loadStringConstants(rootDir: string, sourceBranch: string): Promise<ReadonlyMap<string, string>> {
  // Test and tool sources could otherwise claim a bare name first.
  const productionDirs = ["include", "src"].map((dir) => `${resolveSourcePath(rootDir, dir)}/`);
  const candidateFiles = (await listSourceFiles(sourceBranch, rootDir, [".h", ".hpp", ".cpp"])).filter((filePath) =>
    productionDirs.some((dir) => filePath.startsWith(dir)),
  );
  const sourceTexts = await Promise.all(
    candidateFiles.map((filePath) => readTextFile(resolveRawGithubUrl(sourceBranch, filePath))),
  );

  // First definition wins for both bare and namespace-qualified names.
  const constants = new Map<string, string>();
  sourceTexts.flatMap(scanConstants).forEach(({ name, value }) => {
    if (!constants.has(name)) {
      constants.set(name, value);
    }
  });
  return constants;
}

interface ConstantEntry {
  readonly name: string;
  readonly value: string;
}

const scopeNameFields: Readonly<Record<string, string>> = {
  namespace_definition: "name",
  class_specifier: "name",
  struct_specifier: "name",
};

/**
 * Parses the file once and collects string constants from #define lines and
 * from declarations initialised with a string literal. Each constant is
 * recorded under its bare name and, inside namespaces/classes, under its
 * qualified name too (e.g. both `type` and `fields::type`).
 */
function scanConstants(sourceText: string): readonly ConstantEntry[] {
  const entries: ConstantEntry[] = [];
  const visit = (node: SyntaxNode, scope: readonly string[]): void => {
    const entry = parseConstantNode(node);
    if (entry !== undefined) {
      entries.push(entry);
      if (scope.length > 0) {
        entries.push({ name: [...scope, entry.name].join("::"), value: entry.value });
      }
    }

    // A function's locals are not global constants; the traversal records them when it
    // analyzes the function. A body with a parse error may hide later global code, though.
    if ((node.type === "function_definition" && !node.hasError) || node.type === "lambda_expression") {
      return;
    }
    const scopeField = scopeNameFields[node.type];
    const scopeName = scopeField === undefined ? undefined : childForField(node, scopeField)?.text;
    const childScope = scopeName === undefined ? scope : [...scope, scopeName];
    node.namedChildren.forEach((child) => visit(child, childScope));
  };
  visit(parseCpp(sourceText.replaceAll("\r\n", "\n")), []);
  return entries;
}

function parseConstantNode(node: SyntaxNode): ConstantEntry | undefined {
  if (node.type === "preproc_def") {
    const name = childForField(node, "name")?.text;
    const valueNode = childForField(node, "value");
    const value = valueNode === undefined ? undefined : extractStringLiteral(valueNode.text);
    return name === undefined || value === undefined ? undefined : { name, value };
  }

  if (node.type === "init_declarator") {
    return toEntry(childForField(node, "declarator"), childForField(node, "value"));
  }

  if (node.type === "field_declaration") {
    return toEntry(childForField(node, "declarator"), childForField(node, "default_value"));
  }

  return undefined;
}

function toEntry(declaratorNode: SyntaxNode | undefined, valueNode: SyntaxNode | undefined): ConstantEntry | undefined {
  if (valueNode?.type !== "string_literal") {
    return undefined;
  }
  const name = extractDeclaratorName(declaratorNode);
  const value = extractStringLiteral(valueNode.text);
  return name === undefined || value === undefined ? undefined : { name, value };
}
