import type { DebugConfig } from "../types.js";

export function createDebugLogger(
  routeKey: string,
  debugConfig: DebugConfig,
): (message: string) => void {
  const filter = debugConfig.routeFilter;
  const enabled = debugConfig.enabled || filter !== undefined;
  const shouldLog = filter === undefined || routeKey.includes(filter);

  if (!enabled || !shouldLog) {
    return () => {};
  }

  return (message: string): void => {
    process.stderr.write(`[extractor:${routeKey}] ${message}\n`);
  };
}
