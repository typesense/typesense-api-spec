import { describe, expect, test } from "bun:test";
import { expectToIncludeAll } from "./helpers/assert.js";
import { extractHandler, handlerWithBody } from "./helpers/extract.js";

const expectBodyParams = async (statements: string, expected: readonly string[]): Promise<void> => {
  const { body } = await extractHandler(handlerWithBody(statements));
  expectToIncludeAll(body, expected);
};

describe("control flow", () => {
  test("analyzes if, else-if and else branches", async () => {
    await expectBodyParams(
      `if (x) { auto a = body["a"]; a["in_if"]; }
       else if (y) { auto b = body["b"]; b["in_else_if"]; }
       else { auto c = body["c"]; c["in_else"]; }`,
      ["a.in_if", "b.in_else_if", "c.in_else"],
    );
  });

  test("analyzes single-statement bodies without braces", async () => {
    await expectBodyParams(
      `if (x) body["in_if"];
       else body["in_else"];
       while (y) auto w = body["in_while"];
       for (;;) body["in_for"];`,
      ["in_if", "in_else", "in_while", "in_for"],
    );
  });

  test("analyzes switch cases with and without a block", async () => {
    await expectBodyParams(
      `switch (x) {
         case 1: { auto y = body["case_block"]; y["inner"]; } break;
         default: auto z = body["case_bare"]; z["inner"];
       }`,
      ["case_block.inner", "case_bare.inner"],
    );
  });

  test("analyzes do-while bodies", async () => {
    await expectBodyParams(`do { auto d = body["do_body"]; d["inner"]; } while (false);`, ["do_body.inner"]);
  });

  test("handles declarations in conditions and initializers", async () => {
    await expectBodyParams(
      `if (auto v = body["cond_decl"]) { v["inner"]; }
       if (auto it = body["init_stmt"]; true) it["inner"];
       for (auto e = body["for_init"]; false; ) e["inner"];`,
      ["cond_decl.inner", "init_stmt.inner", "for_init.inner"],
    );
  });
});

describe("variable scope", () => {
  test("an assignment inside a branch reaches the scope that declared the variable", async () => {
    // Regression: POST /multi_search lost searches/union/remove_duplicates.
    const { body } = await extractHandler(`
      bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
        nlohmann::json req_json;
        if (x) {
          get_preset(y, req_json);
        } else {
          try { req_json = nlohmann::json::parse(req->body); } catch (...) {}
        }
        req_json["after_branch"];
        return true;
      }`);
    expect(body).toContain("after_branch");
  });

  test("a re-declaration in a branch shadows the outer alias", async () => {
    const { body } = await extractHandler(handlerWithBody(`
      if (z) { nlohmann::json body; body["shadowed"]; }
      body["visible"];`));
    expect(body).toContain("visible");
    expect(body).not.toContain("shadowed");
  });

  test("assigning to a shadowing variable leaves the outer alias alone", async () => {
    const { body } = await extractHandler(handlerWithBody(`
      if (z) { nlohmann::json body; body = other; }
      body["still_body"];`));
    expect(body).toContain("still_body");
  });
});

describe("value reads", () => {
  test("records .value(key, default), typed from the default", async () => {
    const { body, types } = await extractHandler(
      handlerWithBody(`
        int limit = body.value("limit", 10);
        std::string name = body.value("label", "fallback");
        bool on = body.value("enabled", true);`),
    );
    expectToIncludeAll(body, ["limit", "label", "enabled"]);
    expect(types.get("limit")).toBe("integer");
    expect(types.get("label")).toBe("string");
    expect(types.get("enabled")).toBe("boolean");
  });

  test("records type checks made with is_* methods", async () => {
    const { types } = await extractHandler(handlerWithBody(`if (body["title"].is_string()) { return false; }`));
    expect(types.get("title")).toBe("string");
  });
});

describe("helper calls", () => {
  test("keeps argument positions when a helper has an unnamed parameter", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `unnamed_first("s", body);`,
        `void unnamed_first(const std::string&, nlohmann::json& json_arg) { json_arg["from_helper"]; }`,
      ),
    );
    expect(body).toContain("from_helper");
  });

  test("resolves a call that omits defaulted parameters", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `defaulted(body, 1);`,
        `void defaulted(nlohmann::json& json_arg, int level, bool flag = false) { json_arg["from_helper"]; }`,
      ),
    );
    expect(body).toContain("from_helper");
  });

  test("follows helpers that receive the request object", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `parse_req(req, 1);`,
        `bool parse_req(const std::shared_ptr<http_req>& request, int x) {
           std::string q = request->params["from_req_helper"];
           return true;
         }`,
      ),
    );
    expect(query).toContain("from_req_helper");
  });

  test("follows a qualified call to the right class when method names collide", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `Second::init(req->params);`,
        `void First::init(std::map<std::string, std::string>& params) { params["wrong_class"]; }
         void Second::init(std::map<std::string, std::string>& params) { params["right_class"]; }`,
      ),
    );
    expect(query).toEqual(["right_class"]);
  });

  test("a qualified call does not fall back to another class's method", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `std::find(req->params);`,
        `void Other::find(std::map<std::string, std::string>& params) { params["wrong"]; }`,
      ),
    );
    expect(query).toEqual([]);
  });

  test("a call between same-named methods of different classes is followed", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `Base::validate(body);`,
        `void Derived::validate(nlohmann::json& j) { j["from_derived"]; }
         void Base::validate(nlohmann::json& j) { j["from_base"]; Derived::validate(j); }`,
      ),
    );
    expect(body).toEqual(["from_base", "from_derived"]);
  });

  test("an unqualified call inside a class prefers that class's method", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `Mine::start(body);`,
        `void Other::parse_it(nlohmann::json& j) { j["wrong"]; }
         void Mine::parse_it(nlohmann::json& j) { j["right"]; }
         void Mine::start(nlohmann::json& j) { parse_it(j); }`,
      ),
    );
    expect(body).toEqual(["right"]);
  });

  test("a call with the wrong number of arguments is not bound to that helper", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `two_args(body);`,
        `void two_args(int unrelated, nlohmann::json& j) { j["wrong"]; }`,
      ),
    );
    expect(body).toEqual([]);
  });

  test("does not bind a value to a colliding function that takes other types", async () => {
    // collectionManager.get_preset(name, preset) resolved to the get_preset(req, res) handler.
    const { query } = await extractHandler(
      handlerWithBody(
        `collectionManager.get_preset(req->params["preset"], preset);`,
        `bool get_preset(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
           std::string wrong = req->params["wrong"];
           return true;
         }`,
      ),
    );
    expect(query).toEqual(["preset"]);
  });

  test("a helper's map parameter is the params map only if the caller passed it", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `std::map<std::string, std::string> local; read_map(local, req->params); read_other(body, local);`,
        `void read_map(std::map<std::string, std::string>& other, std::map<std::string, std::string>& params) {
           other["wrong"];
           params["right"];
         }
         void read_other(nlohmann::json& j, std::map<std::string, std::string>& unrelated) { unrelated["wrong"]; }`,
      ),
    );
    expect(query).toEqual(["right"]);
  });

  test("a helper's parameter named req is not the request unless it was passed", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`read_it(body, thing);`, `void read_it(nlohmann::json& j, Thing& req) { req->params["wrong"]; }`),
    );
    expect(query).toEqual([]);
  });

  test("path parameters stay strings when the server converts them", async () => {
    const { types } = await extractHandler(
      handlerWithBody(`uint32_t id = std::stoul(req->params["id"]); remove_doc(req->params["id"]);`, `void remove_doc(uint64_t seq_id) {}`),
      { pathTemplate: "/docs/:id" },
    );
    expect(types.get("id")).toBe("string");
  });

  test("does not follow a request value into a string or number parameter", async () => {
    const { query, body, types } = await extractHandler(
      handlerWithBody(
        `parse_text(req->params["text"]); parse_count(body["count"]); parse_list(body["list"]);`,
        `void parse_text(const std::string& raw) { raw["wrong_from_string"]; }
         void parse_count(uint32_t value) { value["wrong_from_number"]; }
         void parse_list(const std::vector<std::string>& values) { values["wrong_from_vector"]; }`,
      ),
    );
    expect(query).toEqual(["text"]);
    expect(body).toEqual(["count", "list"]);
    expect(types.get("count")).toBe("uint");
    expect(types.get("list")).toBe("string[]");
  });

  test("follows a JSON value into a helper that takes JSON", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `read_nested(body["nested"]);`,
        `void read_nested(const nlohmann::json& section) { section["inner"]; }`,
      ),
    );
    expect(body).toContain("nested.inner");
  });

  test("library methods on tracked values are not followed as helpers", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `body.update(body);`,
        `void update(nlohmann::json& j) { j["wrong"]; }`,
      ),
    );
    expect(body).toEqual([]);
  });

  test("follows a method called on an untracked object", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `Manager::get_instance().add_model(body, id);`,
        `Option<bool> Manager::add_model(nlohmann::json& model, const std::string& id) { model["from_manager"]; return true; }`,
      ),
    );
    expect(body).toContain("from_manager");
  });

  test("stops at the call depth limit and reports it", async () => {
    const { body, diagnosticCodes } = await extractHandler(
      handlerWithBody(
        `first(body);`,
        `void second(nlohmann::json& j) { j["too_deep"]; }
         void first(nlohmann::json& j) { j["reached"]; second(j); }`,
      ),
      { maxCallDepth: 1 },
    );
    expect(body).toContain("reached");
    expect(body).not.toContain("too_deep");
    expect(diagnosticCodes).toContain("max_call_depth_reached");
  });

  test("reports a handler that has no function body", async () => {
    const { diagnosticCodes, body } = await extractHandler("void something_else() {}");
    expect(body).toEqual([]);
    expect(diagnosticCodes).toEqual(["handler_not_found"]);
  });
});

describe("loops", () => {
  test("creates item aliases for body iterables", async () => {
    const { body } = await extractHandler(handlerWithBody(`for (auto& item : body["items"]) { item["sku"]; }`));
    expect(body).toContain("items[].sku");
  });

  test("does not create item aliases for the params map", async () => {
    const { body, query } = await extractHandler(handlerWithBody(`for (auto& kv : req->params) { kv["bogus"]; }`));
    expect([...body, ...query].filter((name) => name.includes("bogus"))).toEqual([]);
  });
});

describe("constants", () => {
  test("prefers the qualified constant over a colliding bare name", async () => {
    const { body } = await extractHandler(handlerWithBody(`body[fields::type];`), {
      constants: { type: "wrong_bare_value", "fields::type": "type" },
    });
    expect(body).toContain("type");
    expect(body).not.toContain("wrong_bare_value");
  });

  test("falls back to the bare name when only that is known", async () => {
    const { body } = await extractHandler(handlerWithBody(`body[fields::locale];`), {
      constants: { locale: "locale" },
    });
    expect(body).toContain("locale");
  });

  test("inside a class method, a bare name means that class's constant", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `Args::parse(req->params);`,
        `void Args::parse(std::map<std::string, std::string>& params) { params[LIMIT]; }`,
      ),
      { constants: { LIMIT: "wrong_global", "Args::LIMIT": "limit" } },
    );
    expect(query).toEqual(["limit"]);
  });

  test("resolves a plain constant identifier", async () => {
    const { body } = await extractHandler(handlerWithBody(`body[SOME_KEY];`), {
      constants: { SOME_KEY: "resolved_key" },
    });
    expect(body).toContain("resolved_key");
  });
});

describe("server-side writes", () => {
  test("copying a path param into the body keeps the body alias", async () => {
    // PUT /synonym_sets/:name reported items as a query parameter.
    const { body, query, path } = await extractHandler(
      handlerWithBody(`
        std::string name = req->params["name"];
        body["name"] = name;
        body["items"];`),
      { pathTemplate: "/sets/:name" },
    );
    expect(body).toEqual(["items"]);
    expect(query).toEqual([]);
    expect(path).toEqual(["name"]);
  });

  test("copying a param into a fresh JSON object still wraps it", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        nlohmann::json wrapper;
        wrapper["kept"] = req->params["kept"];
        wrapper["through_wrapper"];`),
    );
    expect(query).toEqual(["kept", "through_wrapper"]);
  });

  test("storing into the params map is not a client parameter", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        req->params["set_by_server"] = "true";
        req->params["set_from_read"] = req->params["read_by_server"];`),
    );
    expect(query).toEqual(["read_by_server"]);
  });

  test("storing into the body is not a client parameter", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        body["set_by_server"] = "x";
        body["set_nested"]["inner"] = 1;
        body["copied"] = body["read_by_server"];`),
    );
    expect(body).toEqual(["read_by_server"]);
  });

  test("a body default keeps the field reported, through its read", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`if (body.count("optional") == 0) { body["optional"] = 10; }`),
    );
    expect(body).toEqual(["optional"]);
  });

  test("a stored value's type applies to a field clients also send", async () => {
    const { body, types } = await extractHandler(
      handlerWithBody(`if (body.count("flag") == 0) { body["flag"] = false; }`),
    );
    expect(body).toEqual(["flag"]);
    expect(types.get("flag")).toBe("boolean");
  });

  test("reads after an unconditional top-level write are not client parameters", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        body["name"] = compute();
        validate(body["name"]);`),
    );
    expect(body).toEqual([]);
  });

  test("a conditional write does not hide later reads", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        if (missing) { body["name"] = compute(); }
        validate(body["name"]);`),
    );
    expect(body).toEqual(["name"]);
  });

  test("a read before an unconditional write is still a client parameter", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        validate(body["name"]);
        body["name"] = compute();`),
    );
    expect(body).toEqual(["name"]);
  });

  test("storing into a params map held by a helper is not a client parameter", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `apply_defaults(req->params);`,
        `void apply_defaults(std::map<std::string, std::string>& params) {
           params["set_by_server"] = "true";
           params.count("read_by_server");
         }`,
      ),
    );
    expect(query).toEqual(["read_by_server"]);
  });

  test("a param that is both written and read is still reported", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`req->params["both"] = "x"; std::string v = req->params["both"];`),
    );
    expect(query).toEqual(["both"]);
  });
});

describe("parameter locations", () => {
  test("collects path parameters from the route template", async () => {
    const { path } = await extractHandler("void handler() {}", { pathTemplate: "/collections/:collection/docs/:id" });
    expect(path).toEqual(["collection", "id"]);
  });

  test("a helper reading the params map reports path params as path params", async () => {
    const { path, query } = await extractHandler(
      handlerWithBody(
        `read_params(req->params);`,
        `void read_params(std::map<std::string, std::string>& params) { params["collection"]; params["q"]; }`,
      ),
      { pathTemplate: "/collections/:collection/search" },
    );
    expect(path).toEqual(["collection"]);
    expect(query).toEqual(["q"]);
  });

  test("does not report a path parameter as a query parameter", async () => {
    const { path, query } = await extractHandler(
      handlerWithBody(`std::string id = req->params["id"]; std::string q = req->params["only_query"];`),
      { pathTemplate: "/things/:id" },
    );
    expect(path).toEqual(["id"]);
    expect(query).toEqual(["only_query"]);
  });
});

describe("local names and constants", () => {
  // v31's init_join_policy_args produced a bogus `name` query parameter this way.
  test("a lambda parameter is not resolved as a constant of the same name", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        auto get_param = [&](const std::string& name) -> std::string {
          auto it = req->params.find(name);
          return it == req->params.end() ? "" : it->second;
        };`),
      { constants: { name: "name" } },
    );
    expect(query).not.toContain("name");
  });

  test("a call to a local lambda binds its string argument", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        auto get_param = [&](const std::string& name) -> std::string {
          auto it = req->params.find(name);
          return it == req->params.end() ? "" : it->second;
        };
        auto filter = get_param("filter_by");
        auto include = get_param(INCLUDE_FIELDS);`),
      { constants: { name: "name", INCLUDE_FIELDS: "include_fields" } },
    );
    expect(query).toEqual(["filter_by", "include_fields"]);
  });

  test("a call to a local lambda binds its alias arguments", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        auto read_field = [](nlohmann::json& j) { j["from_lambda"]; };
        read_field(body);`),
    );
    expect(body).toContain("from_lambda");
  });

  test("a lambda body sees aliases from the enclosing function", async () => {
    const { body } = await extractHandler(handlerWithBody(`auto f = [&]() { body["captured"]; };`));
    expect(body).toContain("captured");
  });

  test("a local variable hides a constant of the same name", async () => {
    const { body } = await extractHandler(handlerWithBody(`std::string label = compute(); body[label];`), {
      constants: { label: "wrong" },
    });
    expect(body).not.toContain("wrong");
  });

  test("a const local resolves to its string literal, whatever its case", async () => {
    const { body } = await extractHandler(handlerWithBody(`const char* key = "from_local"; body[key];`));
    expect(body).toContain("from_local");
  });

  test("a non-const local does not resolve to its initial string", async () => {
    const { body } = await extractHandler(handlerWithBody(`std::string key = ""; key = compute(); body[key];`));
    expect(body).not.toContain("");
  });

  test("a loop variable hides a constant of the same name", async () => {
    const { body } = await extractHandler(handlerWithBody(`for (auto& label : names) { body[label]; }`), {
      constants: { label: "wrong" },
    });
    expect(body).not.toContain("wrong");
  });

  test("a function parameter hides a constant of the same name", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `read_key(body, compute());`,
        `void read_key(nlohmann::json& j, const std::string& label) { j[label]; }`,
      ),
      { constants: { label: "wrong" } },
    );
    expect(body).not.toContain("wrong");
  });

  test("a helper's string parameter takes the value the caller passed", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `read_key(body, "first"); read_key(body, SECOND);`,
        `void read_key(nlohmann::json& j, const std::string& label) { j[label]; }`,
      ),
      { constants: { label: "wrong", SECOND: "second" } },
    );
    expectToIncludeAll(body, ["first", "second"]);
    expect(body).not.toContain("wrong");
  });

  test("a caller's local variable does not hide a constant inside a helper", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`std::string SOME_KEY = compute(); read_key(body);`, `void read_key(nlohmann::json& j) { j[SOME_KEY]; }`),
      { constants: { SOME_KEY: "from_global" } },
    );
    expect(body).toContain("from_global");
  });
});
