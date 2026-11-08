export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

const CONDITIONAL_DIRECTIVE = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b/;
const NON_CODE_TEXT = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$/g;

interface ConditionalFrame {
  readonly kind: string;
  /** Line index of the directive that opens each branch; the last entry is #endif. */
  readonly directives: number[];
  hasElse: boolean;
}

/**
 * Removes preprocessor branches that open or close braces on their own, as in
 * `#ifdef TEST_BUILD / if (x) { / #endif`, which otherwise breaks parsing of the rest
 * of the file. Assumes the macro is undefined, and blanks lines to keep line numbers.
 */
export function removeUnbalancedConditionals(source: string): string {
  const lines = source.split("\n");
  const stack: ConditionalFrame[] = [];

  lines.forEach((line, index) => {
    const directive = CONDITIONAL_DIRECTIVE.exec(line)?.[1];
    if (directive === undefined) {
      return;
    }
    if (directive === "ifdef" || directive === "ifndef" || directive === "if") {
      stack.push({ kind: directive, directives: [index], hasElse: false });
      return;
    }

    const frame = stack.at(-1);
    if (frame === undefined) {
      return;
    }
    frame.directives.push(index);
    frame.hasElse ||= directive === "else";
    if (directive === "endif") {
      stack.pop();
      resolveIfUnbalanced(lines, frame);
    }
  });

  return lines.join("\n");
}

function resolveIfUnbalanced(lines: string[], frame: ConditionalFrame): void {
  const branchCount = frame.directives.length - 1;
  const branchIsBalanced = (branch: number): boolean => {
    const from = (frame.directives[branch] ?? 0) + 1;
    const to = frame.directives[branch + 1] ?? from;
    return braceDelta(lines.slice(from, to)) === 0;
  };
  if (Array.from({ length: branchCount }, (_unused, branch) => branch).every(branchIsBalanced)) {
    return;
  }

  // With the macro undefined, #ifndef keeps its first branch and the others keep #else.
  const keptBranch = frame.kind === "ifndef" ? 0 : frame.hasElse ? branchCount - 1 : -1;
  const keptFrom = keptBranch < 0 ? -1 : (frame.directives[keptBranch] ?? -1);
  const keptTo = keptBranch < 0 ? -1 : (frame.directives[keptBranch + 1] ?? -1);
  const first = frame.directives[0] ?? 0;
  const last = frame.directives[branchCount] ?? first;
  for (let index = first; index <= last; index += 1) {
    if (index <= keptFrom || index >= keptTo) {
      lines[index] = "";
    }
  }
}

function braceDelta(lines: readonly string[]): number {
  return lines.reduce((delta, line) => {
    const code = line.replace(NON_CODE_TEXT, "");
    return delta + (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
  }, 0);
}

export function normalizePathSegments(segments: readonly string[]): string {
  return segments
    .map((segment, index) => {
      if (segment === '[]') return segment;
      return index > 0 ? `.${segment}` : segment;
    })
    .join('');
}

export function extractPathName(canonicalPath: string): string {
  return canonicalPath
    .split(".")
    .map((part) => part.replaceAll("[]", ""))
    .filter((part) => part.length > 0)
    .at(-1) ?? "";
}

export function sortedReadonly<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
  const copy = [...values];
  copy.sort(compare);
  return copy;
}
