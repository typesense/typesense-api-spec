import { afterEach, describe, expect, test } from "bun:test";
import { loadStringConstants } from "../src/constants.js";
import { inMemoryRepo, nextBranch, stubGithub } from "./helpers/fake-github.js";

let restore = (): void => undefined;
afterEach(() => restore());

const load = async (files: Readonly<Record<string, string>>, rootDir = "") => {
  restore = stubGithub(inMemoryRepo(files));
  return loadStringConstants(rootDir, nextBranch());
};

describe("loadStringConstants", () => {
  test("reads #define and constexpr string constants", async () => {
    const constants = await load({
      "include/a.h": `#define DEFINED_KEY "defined"\nstatic constexpr auto AUTO_KEY = "auto";\nconst char* CHAR_KEY = "char";`,
    });
    expect(constants.get("DEFINED_KEY")).toBe("defined");
    expect(constants.get("AUTO_KEY")).toBe("auto");
    expect(constants.get("CHAR_KEY")).toBe("char");
  });

  test("stores namespaced constants under bare and qualified names", async () => {
    const constants = await load({
      "include/field.h": `namespace fields { static const std::string type = "type"; }`,
    });
    expect(constants.get("type")).toBe("type");
    expect(constants.get("fields::type")).toBe("type");
  });

  test("stores constants nested in namespaces and classes with their full scope", async () => {
    const constants = await load({
      "include/a.h": `namespace outer { struct inner { static constexpr auto KEY = "value"; }; }`,
    });
    expect(constants.get("outer::inner::KEY")).toBe("value");
  });

  test("ignores declarations that are not string literals", async () => {
    const constants = await load({ "include/a.h": `int count = 3;\n#define LIMIT 10\nauto fn = make("x");` });
    expect(constants.size).toBe(0);
  });

  test("keeps the first definition of a duplicate name", async () => {
    const constants = await load({
      "include/a.h": `#define KEY "first"`,
      "include/b.h": `#define KEY "second"`,
    });
    expect(constants.get("KEY")).toBe("first");
  });

  test("only scans C++ sources in include and src of the root directory", async () => {
    const constants = await load(
      {
        "server/include/a.h": `#define IN_INCLUDE "yes"`,
        "server/src/a.cpp": `#define IN_SRC "yes"`,
        "server/test/a_test.cpp": `#define IN_TEST "no"`,
        "server/include/notes.txt": `#define WRONG_EXTENSION "no"`,
        "other/include/b.h": `#define OUTSIDE "no"`,
      },
      "server",
    );
    expect([...constants.keys()].sort()).toEqual(["IN_INCLUDE", "IN_SRC"]);
  });

  test("a test file cannot claim a bare name", async () => {
    const constants = await load({
      "aaa_test/a_test.cpp": `#define KEY "from_test"`,
      "include/a.h": `#define KEY "from_header"`,
    });
    expect(constants.get("KEY")).toBe("from_header");
  });
});
