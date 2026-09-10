export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, '\n');
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
    .filter((part) => part.length > 0 && part !== "[]")
    .at(-1) ?? "";
}

export function sortedReadonly<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
  const copy = [...values];
  copy.sort(compare);
  return copy;
}
