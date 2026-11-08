import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repoRoot } from "./helpers/local-clone.js";

const dirPromise = mkdtemp(path.join(tmpdir(), "cli-test-"));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

const runCli = async (...args: readonly string[]) => {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

describe("cli", () => {
  test("rejects an unknown command", async () => {
    const { stderr, exitCode } = await runCli("bogus");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command: bogus");
  });

  test("defaults to extract when the first argument is a flag", async () => {
    const { stdout, stderr, exitCode } = await runCli("--config", "/does/not/exist.json");
    expect(stderr).not.toContain("Unknown command");
    expect(stdout).toContain("loading config");
    expect(exitCode).toBe(1);
  });

  test("rejects positional arguments to extract", async () => {
    const { stderr, exitCode } = await runCli("extract", "stray");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown arguments: stray");
  });

  test("rejects a non-numeric --max-call-depth", async () => {
    const { stderr, exitCode } = await runCli("extract", "--max-call-depth", "deep");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid value for --max-call-depth: deep");
  });

  test("semantic-diff requires both specs", async () => {
    const { stderr, exitCode } = await runCli("semantic-diff", "--previous", "a.json");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Both --previous and --next are required.");
  });

  test("semantic-diff prints a JSON summary", async () => {
    const dir = await dirPromise;
    const previous = path.join(dir, "previous.json");
    const next = path.join(dir, "next.json");
    await writeFile(previous, JSON.stringify({ routes: [] }));
    await writeFile(
      next,
      JSON.stringify({
        routes: [{ method: "GET", pathTemplate: "/a", pathParams: [], queryParams: [], bodyParams: [] }],
      }),
    );
    const { stdout, exitCode } = await runCli("semantic-diff", "--previous", previous, "--next", next);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ changed: true, addedRoutes: ["GET /a"] });
  });
});
