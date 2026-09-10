import type { ApiDiagnostic, DiagnosticCollector } from "./types.js";

export class MemoryDiagnosticCollector implements DiagnosticCollector {
  readonly #items: ApiDiagnostic[] = [];

  add(diagnostic: ApiDiagnostic): void {
    this.#items.push(diagnostic);
  }

  snapshot(): readonly ApiDiagnostic[] {
    return [...this.#items];
  }
}
