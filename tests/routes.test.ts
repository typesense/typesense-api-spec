import { afterEach, describe, expect, test } from "bun:test";
import { discoverRoutes } from "../src/routes.js";
import { resolveRawGithubUrl } from "../src/source.js";
import { inMemoryRepo, nextBranch, stubGithub } from "./helpers/fake-github.js";

let restore = (): void => undefined;
afterEach(() => restore());

const discover = async (cpp: string) => {
  restore = stubGithub(inMemoryRepo({ "server.cpp": cpp }));
  return discoverRoutes(resolveRawGithubUrl(nextBranch(), "server.cpp"));
};

describe("discoverRoutes", () => {
  test("finds server registrations and maps their HTTP methods", async () => {
    const routes = await discover(`
      void master_server_routes() {
        server->get("/a", get_a);
        server->post("/b", post_b, false, true);
        server->put("/c", put_c);
        server->patch("/d", patch_d);
        server->del("/e", del_e);
      }`);
    expect(routes.map((route) => [route.method, route.pathTemplate, route.handler])).toEqual([
      ["GET", "/a", "get_a"],
      ["POST", "/b", "post_b"],
      ["PUT", "/c", "put_c"],
      ["PATCH", "/d", "patch_d"],
      ["DELETE", "/e", "del_e"],
    ]);
  });

  test("ignores calls that are not route registrations", async () => {
    const routes = await discover(`
      void f() {
        other->get("/a", handler);
        server.get("/b", handler);
        server->listen("/c", handler);
        server->get(path_variable, handler);
        server->get("/d", [](){});
      }`);
    expect(routes).toEqual([]);
  });

  test("records the line and column of each registration", async () => {
    const routes = await discover(`void f() {\n  server->get("/a", h);\n}`);
    expect(routes[0]?.source.line).toBe(2);
    expect(routes[0]?.source.column).toBe(3);
  });

  test("handles CRLF line endings", async () => {
    const routes = await discover(`void f() {\r\n  server->get("/a", h);\r\n}\r\n`);
    expect(routes.map((route) => route.pathTemplate)).toEqual(["/a"]);
  });
});
