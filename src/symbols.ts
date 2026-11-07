import type { SyntaxNode } from "tree-sitter";
import { childForField, extractDeclaratorName, parseCpp } from "./cpp-ast.js";
import { readTextFile } from "./fs.js";
import { normalizeNewlines } from "./text.js";
import { resolveRawGithubUrl, resolveSourcePath } from "./source.js";
import type { FunctionDefinition, FunctionParameter } from "./types.js";

export async function indexFunctions(
  rootDir: string,
  includeHelpers: readonly string[],
  sourceBranch: string,
): Promise<ReadonlyMap<string, FunctionDefinition>> {
  const sourceFiles = [
    "src/core_api.cpp",
    "src/core_api_utils.cpp",
    "src/auth_manager.cpp",
    "src/collection.cpp",
    "src/collection_manager.cpp",
    "src/curation_index_manager.cpp",
    "src/field.cpp",
    "src/synonym_index_manager.cpp",
    "src/tsconfig.cpp",
    ...includeHelpers,
  ]
    .map((filePath) => resolveSourcePath(rootDir, filePath))
    .map((filePath) => resolveRawGithubUrl(sourceBranch, filePath));

  const allDefinitions = (
    await Promise.all(
      sourceFiles.map(async (filePath) => {
        const sourceText = normalizeNewlines(await readTextFile(filePath));
        return extractFunctionDefinitions(filePath, sourceText);
      }),
    )
  ).flat();

  const functions = new Map<string, FunctionDefinition>();
  allDefinitions.forEach((definition) => {
    const maxArity = definition.parameters.length;
    const minArity = definition.parameters.filter((parameter) => !parameter.hasDefault).length;
    for (let arity = minArity; arity <= maxArity; arity += 1) {
      const overloadKey = serializeOverloadKey(definition.name, arity);
      if (!functions.has(overloadKey)) {
        functions.set(overloadKey, definition);
      }
    }
    if (!functions.has(definition.name)) {
      functions.set(definition.name, definition);
    }
  });

  return functions;
}

function serializeOverloadKey(name: string, arity: number): string {
  return `${name}#${arity}`;
}

function extractFunctionDefinitions(filePath: string, sourceText: string): readonly FunctionDefinition[] {
  const rootNode = parseCpp(sourceText);
  return collectFunctionNodes(rootNode).flatMap((functionNode) => {
    const definition = materializeFunctionDefinition(filePath, sourceText, functionNode);
    return definition !== undefined ? [definition] : [];
  });
}

function collectFunctionNodes(node: SyntaxNode): readonly SyntaxNode[] {
  if (node.type === "function_definition") {
    return [node];
  }
  return node.namedChildren.flatMap(collectFunctionNodes);
}

function materializeFunctionDefinition(
  filePath: string,
  sourceText: string,
  functionNode: SyntaxNode,
): FunctionDefinition | undefined {
  const declaratorNode = childForField(functionNode, "declarator");
  const bodyNode = childForField(functionNode, "body");
  if (declaratorNode === undefined || bodyNode === undefined || bodyNode.type !== "compound_statement") {
    return undefined;
  }

  const nameNode = childForField(declaratorNode, "declarator");
  const terminalNameNode =
    nameNode?.type === "qualified_identifier" ? childForField(nameNode, "name") : nameNode;
  if (terminalNameNode?.type === "destructor_name" || terminalNameNode?.type === "operator_name") {
    return undefined;
  }
  const functionName = extractDeclaratorName(nameNode);
  if (functionName === undefined) {
    return undefined;
  }

  return {
    name: functionName,
    filePath,
    declaration: sourceText.slice(functionNode.startIndex, bodyNode.startIndex).trim(),
    body: sourceText.slice(bodyNode.startIndex + 1, bodyNode.endIndex - 1),
    fullText: sourceText.slice(functionNode.startIndex, functionNode.endIndex),
    source: {
      filePath,
      line: functionNode.startPosition.row + 1,
      column: functionNode.startPosition.column + 1,
    },
    parameters: parseParametersFromDeclarator(declaratorNode),
  };
}

function parseParametersFromDeclarator(declaratorNode: SyntaxNode): readonly FunctionParameter[] {
  const parameterListNode = childForField(declaratorNode, "parameters");
  if (parameterListNode === undefined) {
    return [];
  }

  // Keep unnamed and defaulted parameters so parameters[i] lines up with the
  // i-th call argument.
  return parameterListNode.namedChildren
    .filter((parameterNode) => parameterDeclarationTypes.has(parameterNode.type))
    .map((parameterNode) => {
      const nestedDeclarator = childForField(parameterNode, "declarator");
      const defaultValue = childForField(parameterNode, "default_value");
      const typeEnd = nestedDeclarator?.startIndex ?? defaultValue?.startIndex ?? parameterNode.endIndex;
      const typeText = parameterNode.text
        .slice(0, typeEnd - parameterNode.startIndex)
        .replace(/=\s*$/, "")
        .trim();
      return {
        name: extractDeclaratorName(nestedDeclarator) ?? "",
        typeText,
        hasDefault: defaultValue !== undefined,
      };
    });
}

const parameterDeclarationTypes: ReadonlySet<string> = new Set([
  "parameter_declaration",
  "optional_parameter_declaration",
  "variadic_parameter_declaration",
]);
