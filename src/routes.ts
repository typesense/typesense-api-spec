import { childForField, parseCpp, walkNamed } from './cpp-ast.js';
import { readTextFile } from './fs.js';
import { normalizeNewlines } from './text.js';
import { type CppHttpMethod, type RouteRegistration, HttpMethodMap } from './types.js';

export async function discoverRoutes(routeFilePath: string): Promise<readonly RouteRegistration[]> {
  const sourceText = normalizeNewlines(await readTextFile(routeFilePath));
  const rootNode = parseCpp(sourceText);
  const routes: RouteRegistration[] = [];

  walkNamed(rootNode, (node) => {
    if (node.type !== 'call_expression') {
      return;
    }

    const functionNode = childForField(node, 'function');
    const functionParts = functionNode === undefined ? undefined : parseFieldExpression(functionNode);
    if (functionParts === undefined) {
      return;
    }

    if (functionParts.operator !== '->' || functionParts.baseName !== 'server' || !isHttpMethodToken(functionParts.fieldName)) {
      return;
    }

    const argumentListNode = node.namedChildren.find((child) => child.type === 'argument_list');
    const pathNode = argumentListNode?.namedChildren[0];
    const handlerNode = argumentListNode?.namedChildren[1];
    const pathTemplate = pathNode === undefined ? undefined : extractStringLiteral(pathNode.text);
    const handler = handlerNode?.type === 'identifier' ? handlerNode.text : undefined;
    if (pathTemplate === undefined || handler === undefined) {
      return;
    }

    routes.push({
      method: HttpMethodMap[functionParts.fieldName],
      pathTemplate,
      handler,
      source: {
        filePath: routeFilePath,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
      },
    });
  });

  return routes;
}

function parseFieldExpression(node: { readonly type: string; readonly text: string; childForFieldName(fieldName: string): unknown }): {
  readonly baseName: string;
  readonly fieldName: string;
  readonly operator: string;
} | undefined {
  if (node.type !== 'field_expression') {
    return undefined;
  }

  const argumentNode = childForField(node as never, 'argument');
  const fieldNode = childForField(node as never, 'field');
  const operatorNode = childForField(node as never, 'operator');
  if (argumentNode === undefined || fieldNode === undefined || operatorNode === undefined) {
    return undefined;
  }

  if (argumentNode.type !== 'identifier') {
    return undefined;
  }

  return {
    baseName: argumentNode.text,
    fieldName: fieldNode.text,
    operator: operatorNode.text,
  };
}

function isHttpMethodToken(token: string): token is CppHttpMethod {
  return token in HttpMethodMap;
}

function extractStringLiteral(value: string): string | undefined {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, value.length - 1) : undefined;
}
