import { afterEach, describe, expect, test } from "bun:test";
import { indexFunctions } from "../src/symbols.js";
import { inMemoryRepo, nextBranch, stubGithub } from "./helpers/fake-github.js";

let restore = (): void => undefined;
afterEach(() => restore());

const index = async (cpp: string, extraFiles: Readonly<Record<string, string>> = {}, helpers: readonly string[] = []) => {
  restore = stubGithub(inMemoryRepo({ "src/core_api.cpp": cpp, ...extraFiles }));
  return indexFunctions("", helpers, nextBranch());
};

describe("indexFunctions", () => {
  test("registers the name and every accepted arity", async () => {
    const functions = await index("void f(int a, int b = 1, int c = 2) {}");
    expect(functions.has("f")).toBe(true);
    expect(functions.has("f#0")).toBe(false);
    expect(functions.has("f#1")).toBe(true);
    expect(functions.has("f#2")).toBe(true);
    expect(functions.has("f#3")).toBe(true);
    expect(functions.has("f#4")).toBe(false);
  });

  test("keeps unnamed parameters in position", async () => {
    const functions = await index("void f(const std::string&, nlohmann::json& body) {}");
    expect(functions.get("f")?.parameters.map((parameter) => parameter.name)).toEqual(["", "body"]);
  });

  test("records parameter types without their names or defaults", async () => {
    const functions = await index("void f(const std::string& s, bool flag = false) {}");
    expect(functions.get("f")?.parameters).toEqual([
      { name: "s", typeText: "const std::string", hasDefault: false },
      { name: "flag", typeText: "bool", hasDefault: true },
    ]);
  });

  test("skips destructors and operators", async () => {
    const functions = await index(`
      Thing::~Thing() { cleanup(); }
      bool Thing::operator==(const Thing& other) const { return true; }
      void Thing::real() {}`);
    expect(functions.has("real")).toBe(true);
    expect(functions.has("cleanup")).toBe(false);
    expect(functions.has("other")).toBe(false);
    expect(functions.has("Thing")).toBe(false);
  });

  test("indexes qualified methods under their short name", async () => {
    const functions = await index("void Manager::do_work(int a) {}");
    expect(functions.get("do_work")?.parameters).toHaveLength(1);
  });

  test("registers qualified names with every shorter suffix", async () => {
    const functions = await index("void Outer::Inner::do_work(int a) {}");
    for (const key of ["Outer::Inner::do_work#1", "Inner::do_work#1", "do_work#1"]) {
      expect(functions.get(key)?.qualifiedName).toBe("Outer::Inner::do_work");
    }
  });

  test("keeps same-named methods of different classes apart", async () => {
    const functions = await index("void A::init(int a) {}\nvoid B::init(int b) {}");
    expect(functions.get("A::init#1")?.parameters[0]?.name).toBe("a");
    expect(functions.get("B::init#1")?.parameters[0]?.name).toBe("b");
    expect(functions.get("init#1")?.parameters[0]?.name).toBe("a");
  });

  test("indexes every source file except src/main, with priority files winning short names", async () => {
    const functions = await index("void shared() { from_core_api(); }", {
      "src/a_manager.cpp": "void shared() { from_manager(); }\nvoid only_in_manager() {}",
      "src/main/server.cpp": "void only_in_main() {}",
      "test/a_test.cpp": "void only_in_test() {}",
    });
    expect(functions.get("shared")?.body).toContain("from_core_api");
    expect(functions.has("only_in_manager")).toBe(true);
    expect(functions.has("only_in_main")).toBe(false);
    expect(functions.has("only_in_test")).toBe(false);
  });

  test("keeps the first definition when an arity is defined twice", async () => {
    const functions = await index("void f(int first) {}\nvoid f(int second) {}");
    expect(functions.get("f#1")?.parameters[0]?.name).toBe("first");
  });

  test("includes configured helper files", async () => {
    const functions = await index("", { "src/extra.cpp": "void from_extra() {}" }, ["src/extra.cpp"]);
    expect(functions.has("from_extra")).toBe(true);
  });

  test("records where each function was defined", async () => {
    const functions = await index("\n\nvoid f() {}");
    const source = functions.get("f")?.source;
    expect(source?.line).toBe(3);
    expect(source?.column).toBe(1);
    expect(source?.filePath).toEndWith("/src/core_api.cpp");
  });
});
