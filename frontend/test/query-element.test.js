// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";

import { queryCompletion } from "../src/editors/complete.js";
import { MongQueryEditor } from "../src/editors/element.js";
import { clearMappingCache } from "../src/editors/fields.js";
import { labels, withCursor } from "./helpers.js";

const contacts = {
  index_id: "contacts", name: "contacts_search", type: "SEARCH", generation_id: "contacts-v1",
  definition: { mappings: { dynamic: true, fields: { account_id: { type: "token" } } } },
};
const accounts = {
  index_id: "accounts", name: "accounts_search", type: "SEARCH", generation_id: "accounts-v1",
  definition: { mappings: { dynamic: true, fields: { _id: { type: "token" } } } },
};
const other = { ...accounts, index_id: "other", name: "other_search" };
const observed = {
  contacts: { dynamic: false, fields: { full_name: { type: "string" } } },
  accounts: { dynamic: false, fields: { description: { type: "string" } } },
  other: { dynamic: false, fields: { department: { type: "string" } } },
};

function joinQuery(from = "accounts_search") {
  return `{"compound":{"filter":[{"join":{"from":"${from}","localField":"account_id","foreignField":"_id","operator":{"text":{"path":"de|","query":"software"}}}}],"must":[{"text":{"path":"full_name","query":"nancy"}}]}}`;
}

const editors = [];

function mount(text) {
  const editor = new MongQueryEditor();
  editor.indexes = [contacts, accounts, other];
  editor.indexId = contacts.index_id;
  editor.value = text.replace("|", "");
  document.body.append(editor);
  editors.push(editor);
  return editor;
}

function complete(editor, text) {
  return labels(queryCompletion({ ...withCursor(text), explicit: true }, editor._model));
}

describe("query editor join mappings", () => {
  beforeEach(() => {
    clearMappingCache();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const id = /\/indexes\/([^/]+)\//.exec(url)[1];
      return { ok: true, json: async () => ({ mappings: observed[id] }) };
    }));
  });

  afterEach(() => {
    for (const editor of editors.splice(0)) {
      editor._view.destroy();
      editor.remove();
    }
    vi.unstubAllGlobals();
  });

  it("completes dynamic foreign fields in an existing join without loading unrelated indexes", async () => {
    const editor = mount(joinQuery());
    await vi.waitFor(() => expect(editor._model.mappings.accounts).toBeDefined());
    expect(complete(editor, joinQuery())).toEqual(["description"]);
    expect(complete(editor, '{"text":{"path":"full|","query":"nancy"}}')).toEqual(["full_name"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    editor.value = joinQuery().replace("de|", "description");
    expect(editor.diagnostics).toEqual([]);
  });

  it("loads multiple joined indexes while the query is incomplete", async () => {
    const editor = mount('{"compound":{"filter":[{"join":{"from":"accounts_search"}},{"join":{"from":"other_search"}}],"must":[{"text":{"path":"full');
    await vi.waitFor(() => {
      expect(editor._model.mappings.accounts).toBeDefined();
      expect(editor._model.mappings.other).toBeDefined();
    });
    expect(complete(editor, joinQuery())).toEqual(["description"]);
    expect(complete(editor, joinQuery("other_search"))).toEqual(["department"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["typing", "value setter"])("loads a join added through %s and reuses cached mappings", async (method) => {
    const editor = mount('{"text":{"path":"full_name","query":"nancy"}}');
    await vi.waitFor(() => expect(editor._model.mappings.contacts).toBeDefined());
    const query = withCursor(joinQuery());
    if (method === "typing") {
      editor._view.dispatch({ changes: { from: 0, to: editor.value.length, insert: query.state.doc.toString() } });
    } else {
      editor.value = query.state.doc.toString();
    }
    await vi.waitFor(() => expect(editor._model.mappings.accounts).toBeDefined());
    expect(complete(editor, joinQuery())).toEqual(["description"]);
    editor.value = withCursor(joinQuery("other_search")).state.doc.toString();
    await vi.waitFor(() => expect(editor._model.mappings.other).toBeDefined());
    expect(complete(editor, joinQuery("other_search"))).toEqual(["department"]);
    editor.value = query.state.doc.toString();
    await editor._loadMappings();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes autocomplete when a delayed foreign mapping arrives", async () => {
    const fetchMappings = fetch.getMockImplementation();
    let resolveForeign;
    const pending = new Promise((resolve) => { resolveForeign = resolve; });
    fetch.mockImplementation((url) => url.includes("/accounts/") ? pending : fetchMappings(url));
    const editor = mount("{}");
    await vi.waitFor(() => expect(editor._model.mappings.contacts).toBeDefined());
    const query = withCursor(joinQuery());
    editor._view.dispatch({
      changes: { from: 0, to: editor.value.length, insert: query.state.doc.toString() },
      selection: { anchor: query.pos },
    });
    editor.focus();
    startCompletion(editor._view);
    await vi.waitFor(() => expect(completionStatus(editor._view.state)).toBeNull());
    resolveForeign({ ok: true, json: async () => ({ mappings: observed.accounts }) });
    await vi.waitFor(() => expect(currentCompletions(editor._view.state).map((option) => option.label)).toContain("description"));
  });

  it("retries a failed foreign mapping request on the next edit", async () => {
    const fetchMappings = fetch.getMockImplementation();
    let failed = false;
    fetch.mockImplementation((url) => {
      if (url.includes("/accounts/") && !failed) {
        failed = true;
        return Promise.resolve({ ok: false });
      }
      return fetchMappings(url);
    });
    const editor = mount(joinQuery());
    await vi.waitFor(() => expect(editor._model.mappings.contacts).toBeDefined());
    expect(editor._model.mappings.accounts).toBeUndefined();
    editor.value += " ";
    await vi.waitFor(() => expect(editor._model.mappings.accounts).toBeDefined());
    expect(complete(editor, joinQuery())).toEqual(["description"]);
  });

  it("ignores a delayed response from an older foreign generation", async () => {
    const fetchMappings = fetch.getMockImplementation();
    let resolveOld;
    const pending = new Promise((resolve) => { resolveOld = resolve; });
    fetch.mockImplementation((url) => url.includes("generation_id=accounts-v1") ? pending : fetchMappings(url));
    const editor = mount(joinQuery());
    await vi.waitFor(() => expect(editor._model.mappings.contacts).toBeDefined());
    editor.indexes = [contacts, { ...accounts, generation_id: "accounts-v2" }, other];
    await vi.waitFor(() => expect(editor._model.mappings.accounts).toBeDefined());
    resolveOld({ ok: true, json: async () => ({ mappings: { fields: { deprecated: { type: "string" } } } }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(complete(editor, joinQuery())).toEqual(["description"]);
  });
});
