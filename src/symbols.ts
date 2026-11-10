import type { SyntaxNode } from "tree-sitter";
import { childForField, extractDeclaratorName, parseCpp } from "./cpp-ast.js";
import { readTextFile } from "./fs.js";
import { normalizeNewlines, removeUnbalancedConditionals } from "./text.js";
import { listSourceFiles, resolveRawGithubUrl, resolveSourcePath } from "./source.js";
import type { FunctionDefinition, FunctionParameter } from "./types.js";

// When two definitions share a short name, the first one indexed wins, so the
// files that handle requests come first. Qualified lookups are not affected.
const PRIORITY_SOURCE_FILES: readonly string[] = [
  "src/core_api.cpp",
  "src/core_api_utils.cpp",
  "src/auth_manager.cpp",
  "src/collection.cpp",
  "src/collection_manager.cpp",
  "src/curation_index_manager.cpp",
  "src/field.cpp",
  "src/synonym_index_manager.cpp",
  "src/tsconfig.cpp",
];

export async function indexFunctions(
  rootDir: string,
  includeHelpers: readonly string[],
  sourceBranch: string,
): Promise<ReadonlyMap<string, FunctionDefinition>> {
  const available = await listSourceFiles(sourceBranch, rootDir, [".cpp"]);
  const sourceDir = resolveSourcePath(rootDir, "src");
  const priority = PRIORITY_SOURCE_FILES.map((filePath) => resolveSourcePath(rootDir, filePath));
  const orderedFiles = [
    ...priority.filter((filePath) => available.includes(filePath)),
    ...available.filter((filePath) => isIndexableSource(filePath, sourceDir) && !priority.includes(filePath)),
    ...includeHelpers.map((filePath) => resolveSourcePath(rootDir, filePath)),
  ];
  const sourceFiles = [...new Set(orderedFiles)].map((filePath) => resolveRawGithubUrl(sourceBranch, filePath));

  const allDefinitions = (
    await Promise.all(
      sourceFiles.map(async (filePath) => {
        const sourceText = removeUnbalancedConditionals(normalizeNewlines(await readTextFile(filePath)));
        return extractFunctionDefinitions(filePath, sourceText);
      }),
    )
  ).flat();

  const functions = new Map<string, FunctionDefinition>();
  const register = (key: string, definition: FunctionDefinition): void => {
    if (!functions.has(key)) {
      functions.set(key, definition);
    }
  };
  allDefinitions.forEach((definition) => {
    const maxArity = definition.parameters.length;
    const minArity = definition.parameters.filter((parameter) => !parameter.hasDefault).length;
    // `A::B::f` can also be called as `B::f` or `f`.
    const nameParts = definition.qualifiedName.split("::");
    nameParts.forEach((_part, index) => {
      const name = nameParts.slice(index).join("::");
      register(name, definition);
      for (let arity = minArity; arity <= maxArity; arity += 1) {
        register(serializeOverloadKey(name, arity), definition);
      }
    });
  });

  return functions;
}

function isIndexableSource(filePath: string, sourceDir: string): boolean {
  return filePath.startsWith(`${sourceDir}/`) && !filePath.startsWith(`${sourceDir}/main/`);
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
  // C++ functions don't nest, but after a parse error tree-sitter can stretch a
  // function to the end of the file, making the ones after it look nested.
  if (node.type === "function_definition" && !node.hasError) {
    return [node];
  }
  const nested = node.namedChildren.flatMap(collectFunctionNodes);
  return node.type === "function_definition" ? [node, ...nested] : nested;
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
  const terminalNameNode = nameNode?.type === "qualified_identifier" ? childForField(nameNode, "name") : nameNode;
  if (terminalNameNode?.type === "destructor_name" || terminalNameNode?.type === "operator_name") {
    return undefined;
  }
  const functionName = extractDeclaratorName(nameNode);
  if (functionName === undefined) {
    return undefined;
  }

  return {
    name: functionName,
    qualifiedName: qualifiedFunctionName(nameNode, functionName),
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

function qualifiedFunctionName(nameNode: SyntaxNode | undefined, functionName: string): string {
  if (nameNode?.type !== "qualified_identifier") {
    return functionName;
  }
  // Drop template arguments and whitespace: `Foo<T> :: bar` is `Foo::bar`.
  return nameNode.text
    .replace(/<[^<>]*>/g, "")
    .replace(/\s+/g, "")
    .replace(/^::/, "");
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
