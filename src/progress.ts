export class ProgressReporter {
  readonly #jsonMode: boolean;

  constructor(jsonMode: boolean) {
    this.#jsonMode = jsonMode;
  }

  startStep(name: string): StepHandle {
    if (this.#jsonMode) {
      process.stdout.write(`${JSON.stringify({ event: "step:start", name })}\n`);
    } else {
      process.stdout.write(`* ${name}\n`);
    }
    return new StepHandle(name, this.#jsonMode);
  }

  info(message: string): void {
    if (this.#jsonMode) {
      process.stdout.write(`${JSON.stringify({ event: "info", message })}\n`);
      return;
    }
    process.stdout.write(`  ${message}\n`);
  }
}

class StepHandle {
  readonly #name: string;
  readonly #jsonMode: boolean;
  readonly #startedAt: number;

  constructor(name: string, jsonMode: boolean) {
    this.#name = name;
    this.#jsonMode = jsonMode;
    this.#startedAt = Date.now();
  }

  done(details?: string): void {
    const elapsedMs = Date.now() - this.#startedAt;
    if (this.#jsonMode) {
      process.stdout.write(`${JSON.stringify({ event: "step:done", name: this.#name, elapsedMs, details })}\n`);
      return;
    }

    const suffix = details === undefined ? "" : ` ${details}`;
    process.stdout.write(`  done ${this.#name} (${elapsedMs}ms)${suffix}\n`);
  }
}
