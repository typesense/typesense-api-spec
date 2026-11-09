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
    const { body } = await extractHandler(
      handlerWithBody(`
      if (z) { nlohmann::json body; body["shadowed"]; }
      body["visible"];`),
    );
    expect(body).toContain("visible");
    expect(body).not.toContain("shadowed");
  });

  test("assigning to a shadowing variable leaves the outer alias alone", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
      if (z) { nlohmann::json body; body = other; }
      body["still_body"];`),
    );
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

  test("keeps tracking a value through get<nlohmann::json>()", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`const auto& data = body["data"].get<nlohmann::json>(); data["nested"];`),
    );
    expect(body).toContain("data.nested");
  });

  test("get<std::string>() yields a plain value, not a tracked one", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`auto text = body["text"].get<std::string>(); text["wrong"];`),
    );
    expect(body).toEqual(["text"]);
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

  test("follows a call that relies on defaults declared only in the header", async () => {
    // curation_t::parse(json, id, out) has six parameters in curation.cpp.
    const { body } = await extractHandler(
      handlerWithBody(
        `Parser::parse(body, "id");`,
        `Option<bool> Parser::parse(const nlohmann::json& j, const std::string& id, const std::string& locale, int mode) {
           j["from_parser"];
           return true;
         }`,
      ),
    );
    expect(body).toContain("from_parser");
  });

  test("a call with too many arguments is not bound to that helper", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`one_arg(body, 1, 2);`, `void one_arg(nlohmann::json& j) { j["wrong"]; }`),
    );
    expect(body).toEqual([]);
  });

  test("a call with the wrong number of arguments is not bound to that helper", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`two_args(body);`, `void two_args(int unrelated, nlohmann::json& j) { j["wrong"]; }`),
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
      handlerWithBody(
        `uint32_t id = std::stoul(req->params["id"]); remove_doc(req->params["id"]);`,
        `void remove_doc(uint64_t seq_id) {}`,
      ),
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
      handlerWithBody(`body.update(body);`, `void update(nlohmann::json& j) { j["wrong"]; }`),
    );
    expect(body).toEqual([]);
  });

  test("picks the method by the receiver's name when classes share a method", async () => {
    // doc_analytics.add_event and search_analytics.add_event both take (ip, json).
    const { body } = await extractHandler(
      handlerWithBody(
        `doc_analytics.add_event(ip, body); search_analytics.add_event(ip, body);`,
        `Option<bool> DocAnalytics::add_event(const std::string& ip, const nlohmann::json& e) { e["doc_id"]; return true; }
         Option<bool> SearchAnalytics::add_event(const std::string& ip, const nlohmann::json& e) { e["q"]; return true; }`,
      ),
    );
    expect(body).toEqual(["doc_id", "q"]);
  });

  test("picks the method from Class::get_instance()", async () => {
    const { body } = await extractHandler(
      handlerWithBody(
        `Second::get_instance().add(body);`,
        `void First::add(nlohmann::json& j) { j["wrong"]; }
         void Second::add(nlohmann::json& j) { j["right"]; }`,
      ),
    );
    expect(body).toEqual(["right"]);
  });

  test("falls back to the short name when the receiver says nothing", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`thing.add(body);`, `void Only::add(nlohmann::json& j) { j["found"]; }`),
    );
    expect(body).toEqual(["found"]);
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

describe("parse errors", () => {
  const brokenHandler = `
    bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
      nlohmann::json body = nlohmann::json::parse(req->body);
      auto f = [&]() {
        if (x) { y();
      };
      body["before_error"];
      read_more(body);
    }
    void read_more(nlohmann::json& j) { j["from_later_helper"]; }
    void never_called(nlohmann::json& body) { body["not_called"]; }`;

  test("follows a helper defined after a parse error", async () => {
    const { body } = await extractHandler(brokenHandler);
    expect(body).toContain("from_later_helper");
  });

  test("does not analyze later functions as part of the broken one", async () => {
    const { body } = await extractHandler(brokenHandler);
    expect(body).toContain("before_error");
    expect(body).not.toContain("not_called");
  });
});

describe("preprocessor conditionals", () => {
  test("reads a function whose #ifdef branches leave braces unbalanced", async () => {
    // AnalyticsManager::add_external_event broke parsing from line 177 to 895.
    const { body } = await extractHandler(
      handlerWithBody(
        `add_event(ip, body);`,
        `Option<bool> add_event(const std::string& ip, const nlohmann::json& event) {
           std::unique_lock lock(mutex);
         #ifdef TEST_BUILD
           if (limited) {
         #endif
           check_rate();
         #ifdef TEST_BUILD
           }
         #endif
           event["name"];
           return true;
         }`,
      ),
    );
    expect(body).toContain("name");
  });
});

describe("JSON objects used as maps", () => {
  test(".items() is a map, not an array", async () => {
    // v31 reported POST /keys joins as joins[] and joins[][].
    const { body, types } = await extractHandler(
      handlerWithBody(`
        const auto& joins = body["joins"];
        if (!joins.is_object()) { return false; }
        for (const auto& join_item : joins.items()) {
          if (!join_item.value().is_object()) { return false; }
          for (const auto& policy_item : join_item.value().items()) {
            if (policy_item.key() != "allowed_fields" && policy_item.key() != "denied_fields") { return false; }
            if (!policy_item.value().is_array()) { return false; }
            for (const auto& field_name : policy_item.value()) {
              if (!field_name.is_string()) { return false; }
            }
          }
        }`),
    );
    expect(body).toEqual(["joins", "joins.*", "joins.*.allowed_fields", "joins.*.denied_fields"]);
    expect(types.get("joins")).toBe("object");
    expect(types.get("joins.*")).toBe("object");
    expect(types.get("joins.*.allowed_fields")).toBe("string[]");
  });

  test(".items() on a field known to be an array means array items", async () => {
    // Collection::validate_alter_payload iterates schema_changes["fields"].items().
    const { body, types } = await extractHandler(
      handlerWithBody(`
        if (!body["fields"].is_array()) { return false; }
        for (const auto& kv : body["fields"].items()) {
          kv.value()["name"];
          kv.value().is_object();
        }`),
    );
    expect(body).toEqual(["fields", "fields[].name"]);
    expect(types.get("fields")).toBe("object[]");
  });

  test("the array check can come after the .items() loop", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        for (const auto& kv : body["fields"].items()) { kv.value()["name"]; }
        if (!body["fields"].is_array()) { return false; }`),
    );
    expect(body).toEqual(["fields", "fields[].name"]);
  });

  test("a map's fields appear under * when none are named", async () => {
    const { body, types } = await extractHandler(
      handlerWithBody(`for (auto& entry : body["metadata"].items()) { entry.value().is_string(); }`),
    );
    expect(body).toEqual(["metadata", "metadata.*"]);
    expect(types.get("metadata.*")).toBe("string");
  });

  test("iterating the top-level body's items adds no parameter for the keys", async () => {
    const { body } = await extractHandler(handlerWithBody(`for (auto& entry : body.items()) { entry.value(); }`));
    expect(body).toEqual([]);
  });

  test("a set of allowed keys checked against item.key() names the body's fields", async () => {
    // PATCH /collections checks the body against allowed_keys.
    const { body } = await extractHandler(
      handlerWithBody(`
        std::set<std::string> allowed_keys = {"metadata", "fields"};
        for (auto it : body.items()) {
          if (allowed_keys.count(it.key()) == 0) { return false; }
        }`),
    );
    expect(body).toEqual(["fields", "metadata"]);
  });

  test("comparing item.key() names a field", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`for (auto& it : body.items()) { if (it.key() == "known") { use(it.value()); } }`),
    );
    expect(body).toEqual(["known"]);
  });

  test("a key the server refuses or ignores is not a field", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        for (auto& it : body.items()) {
          if (it.key() == "ignored") { continue; }
          if (it.key() == "refused") { return false; }
          if (flag && it.key() == "sometimes") { return false; }
        }`),
    );
    expect(body).toEqual(["sometimes"]);
  });

  test("converting or validating a query value declares its type", async () => {
    const { types } = await extractHandler(`
      bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
        const size_t size = std::stoi(req->params["size"]);
        const auto& limit = req->params["limit"];
        if (!StringUtils::is_uint32_t(limit)) { return false; }
        req->params["plain"];
        return true;
      }`);
    expect(types.get("size")).toBe("integer");
    expect(types.get("limit")).toBe("uint");
    expect(types.get("plain")).toBeUndefined();
  });

  test("the value behind a params.find() iterator types that parameter", async () => {
    const { query, types } = await extractHandler(`
      bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
        const auto ttl_it = req->params.find("ttl");
        if (ttl_it != req->params.end() && StringUtils::is_int32_t(ttl_it->second)) { use(); }
        const auto cache_it = req->params.find("cache");
        bool cache = cache_it != req->params.end() && (cache_it->second == "1" || cache_it->second == "true");
        return true;
      }`);
    expect(query).toEqual(["cache", "ttl"]);
    expect(types.get("ttl")).toBe("integer");
    expect(types.get("cache")).toBe("boolean");
  });

  test("a reassigned params.find() iterator follows its new parameter", async () => {
    const { query, types } = await extractHandler(`
      bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
        auto it = req->params.find("x");
        it = req->params.find("y");
        std::stoi(it->second);
        auto other_it = req->params.find("z");
        other_it = other.find("unrelated");
        std::stoi(other_it->second);
        return true;
      }`);
    expect(query).toEqual(["x", "y", "z"]);
    expect(types.get("x")).toBeUndefined();
    expect(types.get("y")).toBe("integer");
    expect(types.get("z")).toBeUndefined();
  });

  test("a numeric union keeps its narrowest type, which validation declares", async () => {
    // list_collections rejects a negative offset with is_uint32_t, then converts it with stoi.
    const { types } = await extractHandler(`
      bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
        if (!StringUtils::is_uint32_t(req->params["n"])) { return false; }
        std::stoi(req->params["n"]);
        return true;
      }`);
    expect(types.get("n")).toBe("uint");
  });

  test("a branch that uses a key's value before leaving handles that field", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        for (auto& it : body.items()) {
          if (it.key() == "a" || it.key() == "b") { use(it.value()); continue; }
          if (it.key() == "c") { return process(it); }
          if (it.key() == "refused") { return error("Field " + it.key() + " is not allowed"); }
        }
        for (auto& [key, value] : body["nested"].items()) {
          if (key == "d") { use(value); continue; }
          if (key == "skipped") { continue; }
        }`),
    );
    expect(body).toEqual(["a", "b", "c", "nested", "nested.d"]);
  });

  test("copying the whole body into the params map mirrors params as top-level fields", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        for (auto& it : body.items()) {
          if (it.key() == "skipped") { continue; }
          req->params[it.key()] = it.value();
        }
        req->params["kept"];
        req->params["skipped"];`),
    );
    expect(body).toEqual(["kept"]);
  });

  test("a refused key isn't a field, even where it is read directly", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        body["before"];
        for (auto& it : body.items()) {
          if (it.key() == "before" || it.key() == "after") { return Option<bool>(400, "Not allowed."); }
          if (it.key() == "rejected") { res->set(400, "Not allowed."); return false; }
          if (it.key() == "done") { return true; }
        }
        body["after"];
        body["rejected"];
        body["done"];`),
    );
    expect(body).toEqual(["done"]);
  });

  test("a key skip list covers every key it names", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        for (auto& it : body.items()) {
          if (it.key() == "a" || (it.key() == "b" || it.key() == "c")) { continue; }
          if (it.key() == "kept") { use(); }
        }`),
    );
    expect(body).toEqual(["kept"]);
  });

  test("a skipped key still counts when the field is read directly", async () => {
    // add_event skips doc_ids while copying custom fields, but reads it directly elsewhere.
    const { body } = await extractHandler(
      handlerWithBody(`
        body["before"];
        for (auto& it : body.items()) {
          if (it.key() == "before" || it.key() == "after") { continue; }
        }
        body["after"];`),
    );
    expect(body).toEqual(["after", "before"]);
  });

  test("filling in a default for a missing field doesn't make it a field", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        if (body.count("filled") == 0) { body["filled"] = 1; }
        if (body.count("used") == 0) { body["used"] = 1; }
        body["used"];
        if (body.count("required") == 0) { return false; }`),
    );
    expect(body).toEqual(["required", "used"]);
  });

  test("copying a body's items into another object keeps tracking its fields", async () => {
    // update_model merges the request into a copy of the stored model, then validates it.
    const { body } = await extractHandler(
      handlerWithBody(
        `update_model(body);`,
        `void validate(const nlohmann::json& m) { m["validated"]; }
         void update_model(nlohmann::json model) {
           nlohmann::json model_copy = existing();
           for (auto& [key, value] : model.items()) {
             model_copy[key] = value;
           }
           validate(model_copy);
         }`,
      ),
    );
    expect(body).toContain("validated");
  });

  test("copying item.key() into another object keeps tracking its fields", async () => {
    const { body } = await extractHandler(
      handlerWithBody(`
        nlohmann::json merged = existing();
        for (auto& it : body.items()) { merged[it.key()] = it.value(); }
        merged["through_copy"];`),
    );
    expect(body).toContain("through_copy");
  });

  test("a copy into an unrelated target does not change that target", async () => {
    const { body, query } = await extractHandler(
      handlerWithBody(`
        for (auto& [key, value] : other.items()) { merged[key] = value; }
        merged["wrong"];`),
    );
    expect([...body, ...query]).toEqual([]);
  });
});

describe("JSON fields copied into the params map", () => {
  const multiSearch = `
    bool add_item(std::map<std::string, std::string>& req_params, const nlohmann::detail::iteration_proxy_value<nlohmann::json::iterator>& item) {
      req_params[item.key()] = item.value().get<std::string>();
      return true;
    }
    void add_params(std::map<std::string, std::string>& req_params, nlohmann::json& search_params) {
      for (auto const& search_item : search_params.items()) {
        if (search_item.key() == "cache_ttl") { continue; }
        add_item(req_params, search_item);
      }
    }
    void do_search(std::map<std::string, std::string>& req_params) {
      std::unordered_map<std::string, size_t*> ints = {{"per_page", &per_page}};
      for (const auto& kv : req_params) { ints.find(kv.first); }
      req_params["q"];
      req_params["cache_ttl"];
    }`;

  const handler = (order: string) => `${multiSearch}
    bool handler(const std::shared_ptr<http_req>& req, const std::shared_ptr<http_res>& res) {
      nlohmann::json body = nlohmann::json::parse(req->body);
      auto limit = req->params["limit_multi_searches"];
      auto& searches = body["searches"];
      for (size_t i = 0; i < searches.size(); i++) {
        auto& search_params = searches[i];
        ${order}
      }
      return true;
    }`;

  test("each item in searches[] accepts the search parameters", async () => {
    const { body, query, types } = await extractHandler(
      handler("add_params(req->params, search_params); do_search(req->params);"),
    );
    expect(body).toContain("searches[].q");
    expect(body).toContain("searches[].per_page");
    expect(types.get("searches[].per_page")).toBe("uint");
    expect(query).toContain("per_page");
  });

  test("params read before the copy are not mirrored", async () => {
    const { body, query } = await extractHandler(
      handler("add_params(req->params, search_params); do_search(req->params);"),
    );
    expect(query).toContain("limit_multi_searches");
    expect(body).not.toContain("searches[].limit_multi_searches");
  });

  test("a field the server ignores is not mirrored", async () => {
    const { body, query } = await extractHandler(
      handler("add_params(req->params, search_params); do_search(req->params);"),
    );
    expect(query).toContain("cache_ttl");
    expect(body).not.toContain("searches[].cache_ttl");
  });
});

describe("loops", () => {
  test("records the iterable itself", async () => {
    const { body } = await extractHandler(handlerWithBody(`for (auto& item : body["list"]) { use(item); }`));
    expect(body).toContain("list");
  });

  test("creates item aliases for body iterables", async () => {
    const { body } = await extractHandler(handlerWithBody(`for (auto& item : body["items"]) { item["sku"]; }`));
    expect(body).toContain("items[].sku");
  });

  test("does not create item aliases for the params map", async () => {
    const { body, query } = await extractHandler(handlerWithBody(`for (auto& kv : req->params) { kv["bogus"]; }`));
    expect([...body, ...query].filter((name) => name.includes("bogus"))).toEqual([]);
  });
});

describe("parameters read through a loop over the params map", () => {
  const overParams = (statements: string): string =>
    handlerWithBody(
      `for (const auto& kv : req->params) { const std::string& key = kv.first; const std::string& val = kv.second; ${statements} }`,
    );

  test("comparing the key names a parameter", async () => {
    const { query } = await extractHandler(overParams(`if (key == PREFIX) {} else if ("literal_key" == key) {}`), {
      constants: { PREFIX: "prefix" },
    });
    expect(query).toEqual(["literal_key", "prefix"]);
  });

  test("comparing the key with kv.first directly names a parameter", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`for (auto& kv : req->params) { if (kv.first == "direct") {} }`),
    );
    expect(query).toEqual(["direct"]);
  });

  test("looking the key up in a table names every key, typed from the table", async () => {
    const { query, types } = await extractHandler(
      handlerWithBody(`
        std::unordered_map<std::string, size_t*> ints = {{PER_PAGE, &per_page}, {"page", &page}};
        std::unordered_map<std::string, bool*> bools = {{"exhaustive", &exhaustive}};
        std::unordered_map<std::string, std::string*> strs = {{"filter_by", &filter}};
        std::unordered_map<std::string, std::vector<std::string>*> lists = {{"query_by", &fields}};
        std::unordered_map<std::string, std::vector<uint32_t>*> int_lists = {{"num_typos", &typos}};
        std::unordered_map<std::string, float*> floats = {{"lambda", &lambda}};
        for (const auto& kv : req->params) {
          const std::string& key = kv.first;
          auto a = ints.find(key);
          auto b = bools.find(key);
          auto c = strs.find(key);
          auto d = lists.find(key);
          auto e = int_lists.find(key);
          auto f = floats.find(key);
        }`),
      { constants: { PER_PAGE: "per_page" } },
    );
    expect(query).toEqual(["exhaustive", "filter_by", "lambda", "num_typos", "page", "per_page", "query_by"]);
    expect(types.get("per_page")).toBe("uint");
    expect(types.get("exhaustive")).toBe("boolean");
    expect(types.get("filter_by")).toBe("string");
    expect(types.get("query_by")).toBe("string[]");
    expect(types.get("num_typos")).toBe("uint[]");
    expect(types.get("lambda")).toBe("number");
  });

  test('comparing a param with "true" declares a boolean', async () => {
    const { types } = await extractHandler(handlerWithBody(`if (req->params["flag"] == "true") {}`));
    expect(types.get("flag")).toBe("boolean");
  });

  test("a plain read keeps the table's type", async () => {
    const { types } = await extractHandler(
      handlerWithBody(`
        std::string raw = req->params["per_page"];
        std::unordered_map<std::string, size_t*> ints = {{"per_page", &per_page}};
        for (const auto& kv : req->params) { ints.find(kv.first); }`),
    );
    expect(types.get("per_page")).toBe("uint");
  });

  test("works through a helper that receives the params map", async () => {
    const { query } = await extractHandler(
      handlerWithBody(
        `Args::init(req->params, 1);`,
        `Option<bool> Args::init(std::map<std::string, std::string>& req_params, const uint32_t& n) {
           std::unordered_map<std::string, bool*> bools = {{FLAG, &flag}};
           for (const auto& kv : req_params) { bools.find(kv.first); }
           return true;
         }`,
      ),
      { constants: { "Args::FLAG": "flag" } },
    );
    expect(query).toEqual(["flag"]);
  });

  test("structured bindings work like kv.first", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`for (const auto& [key, value] : req->params) { if (key == "structured") {} value["wrong"]; }`),
    );
    expect(query).toEqual(["structured"]);
  });

  test("a table looked up with an unrelated key adds nothing", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        std::unordered_map<std::string, bool*> bools = {{"flag", &flag}};
        bools.find(other_key);
        std::string name = "x";
        if (name == "not_a_param") {}`),
    );
    expect(query).toEqual([]);
  });

  test("a table of another type is not treated as known keys", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        std::unordered_map<int, bool*> by_number = {{1, &flag}};
        for (const auto& kv : req->params) { by_number.find(kv.first); }`),
    );
    expect(query).toEqual([]);
  });

  test("a variable with the table's name in an inner scope hides it", async () => {
    const { query } = await extractHandler(
      handlerWithBody(`
        std::unordered_map<std::string, bool*> table = {{"flag", &flag}};
        for (const auto& kv : req->params) {
          auto table = other();
          table.find(kv.first);
        }`),
    );
    expect(query).toEqual([]);
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
      handlerWithBody(`if (body.count("optional") == 0) { body["optional"] = 10; } use(body["optional"]);`),
    );
    expect(body).toEqual(["optional"]);
  });

  test("a stored value's type applies to a field clients also send", async () => {
    const { body, types } = await extractHandler(
      handlerWithBody(`if (body.count("flag") == 0) { body["flag"] = false; } use(body["flag"]);`),
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
      handlerWithBody(
        `std::string SOME_KEY = compute(); read_key(body);`,
        `void read_key(nlohmann::json& j) { j[SOME_KEY]; }`,
      ),
      { constants: { SOME_KEY: "from_global" } },
    );
    expect(body).toContain("from_global");
  });
});
