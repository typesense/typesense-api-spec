export class CountingSemaphore {
  #count: number;
  readonly #waiters: (() => void)[] = [];

  constructor(count: number) {
    if (count < 1) {
      throw new Error("Semaphore count must be at least 1");
    }
    this.#count = count;
  }

  async acquire(): Promise<void> {
    if (this.#count > 0) {
      this.#count -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  release(): void {
    const nextResolve = this.#waiters.shift();
    if (nextResolve !== undefined) {
      nextResolve();
      return;
    }

    this.#count += 1;
  }
}
