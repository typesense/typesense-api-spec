import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import type { CliOptions } from "../src/types.js";
import { rejectionMessage } from "./helpers/assert.js";

const dirPromise = mkdtemp(path.join(tmpdir(), "config-test-"));
afterAll(async () => rm(await dirPromise, { recursive: true, force: true }));

const noCliOptions: CliOptions = {
  command: "extract",
  configPath: undefined,
  outputPath: undefined,
  baseUrl: undefined,
  maxCallDepth: undefined,
  failOnDiagnostics: undefined,
  failOnUnresolved: undefined,
  verbose: false,
  debugRoute: undefined,
  json: false,
};

let counter = 0;
const writeConfig = async (config: unknown): Promise<string> => {
  counter += 1;
  const filePath = path.join(await dirPromise, `config-${counter}.json`);
  await writeFile(filePath, JSON.stringify(config));
  return filePath;
};

describe("loadConfig", () => {
  test("applies defaults and resolves output paths against the config's directory", async () => {
    const dir = await dirPromise;
    const config = await loadConfig(await writeConfig({}), noCliOptions);
    expect(config.sourceBranch).toBe("v30");
    expect(config.routeFile).toBe("src/main/typesense_server.cpp");
    expect(config.maxCallDepth).toBe(8);
    expect(config.outputPath).toBe(path.join(dir, "output/typesense_api_spec.json"));
    expect(config.diagnosticsOutputPath).toBe(path.join(dir, "output/typesense_api_diagnostics.json"));
  });

  test("command-line options take precedence over the file", async () => {
    const config = await loadConfig(
      await writeConfig({ max_call_depth: 2, base_url: "http://file", fail_on_unresolved: true }),
      {
        ...noCliOptions,
        maxCallDepth: 9,
        baseUrl: "http://cli",
        failOnUnresolved: false,
        outputPath: "relative.json",
      },
    );
    expect(config.maxCallDepth).toBe(9);
    expect(config.baseUrl).toBe("http://cli");
    expect(config.failOnUnresolved).toBe(false);
    expect(config.outputPath).toBe(path.resolve("relative.json"));
  });

  test("--verbose turns debug on and --debug-route overrides the filter", async () => {
    const config = await loadConfig(await writeConfig({ debug: { route_filter: "file" } }), {
      ...noCliOptions,
      verbose: true,
      debugRoute: "cli",
    });
    expect(config.debug).toEqual({ enabled: true, routeFilter: "cli" });
  });

  test("rejects unknown keys and names the file", async () => {
    const configPath = await writeConfig({ not_a_real_option: true });
    expect(await rejectionMessage(loadConfig(configPath, noCliOptions))).toContain(
      `Could not parse config file ${configPath}`,
    );
  });

  test("names the field that has the wrong type", async () => {
    const message = await rejectionMessage(loadConfig(await writeConfig({ max_call_depth: "four" }), noCliOptions));
    expect(message).toContain("Error for config field 'max_call_depth'");
  });

  test("accepts the repository's own config", async () => {
    const config = await loadConfig(path.resolve(import.meta.dir, "../config.json"), noCliOptions);
    expect(config.blacklist.paths).toContain("/proxy");
  });
});
