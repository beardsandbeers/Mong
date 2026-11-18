// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import "../src/editors/index.js";
import type { MongQueryEditor } from "../src/editors/element.js";
import type { MongFacetResults } from "../src/components/facet-results";
import { facetValue, readFacet } from "../src/lib/facets";
import { appStore } from "../src/lib/state";
import type { SummaryIndex } from "../src/lib/types";
import { MongExplore } from "../src/views/explore";

const searchIndex: SummaryIndex = {
  index_id: "catalog-id",
  name: "catalog",
  type: "SEARCH",
  type_code: 1,
  active_revision: 1,
  desired_revision: 1,
  generation_id: "gen",
  lifecycle_state: "READY",
  failure_message: null,
  definition: { mappings: { fields: { brand: { type: "token" }, added: { type: "date" } } } },
  metrics: {} as SummaryIndex["metrics"],
};
const otherIndex = { ...searchIndex, index_id: "other-id", name: "other" };
const date = (year: number) => ({ $date: `${year}-01-01T00:00:00Z` });

afterEach(() => {
  document.body.replaceChildren();
  appStore.set({ indexes: [], loaded: false });
  localStorage.clear();
  history.replaceState(null, "", "#/explore");
  vi.unstubAllGlobals();
});

async function mount(index = searchIndex.name, embedded = false) {
  appStore.set({ loaded: true, indexes: [searchIndex, otherIndex, { ...searchIndex, index_id: "vectors-id", name: "vectors", type: "VECTOR_SEARCH" }] });
  const page = new MongExplore();
  page.params = new URLSearchParams({ index });
  page.embedded = embedded;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

async function setQuery(page: MongExplore, query: object) {
  const editor = page.querySelector<MongQueryEditor>("mong-query-editor")!;
  editor.value = JSON.stringify(query);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
}

function button(root: ParentNode, text: string) {
  return [...root.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;
}

function tab(page: MongExplore, label: string) {
  return [...page.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    .find((item) => item.textContent?.trim() === label)!;
}

it("runs a facet query through search-meta and switches between charts and exact bucket tables", async () => {
  const fetch = vi.fn(async (path: string) => path.endsWith("/search-meta")
    ? Response.json({
        metadata: {
          count: { lowerBound: { $numberLong: "9007199254740993" } },
          facet: {
            brands: { buckets: [{ _id: "Bean Co", count: 7 }] },
            years: { buckets: [
              { _id: date(2025), count: { total: 2 }, brands: { buckets: [{ _id: "Bean Co", total: 8 }] } },
              { _id: date(2024), count: { total: 0 } },
            ] },
          },
        },
        latency_ms: 5,
      })
    : new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const page = await mount();
  expect([...page.querySelectorAll('[role="tab"]')].map((item) => item.textContent?.trim()))
    .toEqual(["Browse", "Search", "Aggregate", "Vector"]);
  tab(page, "Aggregate").click();
  await page.updateComplete;
  expect(tab(page, "Aggregate").getAttribute("aria-selected")).toBe("true");
  expect(page.querySelector('button[title="Facet and count metadata, with no hits"]')).toBeNull();
  const picker = page.querySelector<HTMLSelectElement>(".facet-field-select")!;
  picker.value = [...picker.options].find((option) => option.textContent?.includes("brand · string"))!.value;
  picker.dispatchEvent(new Event("change"));
  await page.updateComplete;
  const editor = page.querySelector<MongQueryEditor>("mong-query-editor")!;
  expect(editor.getQuery()).toEqual({ facet: { facets: { brand: { type: "string", path: "brand", numBuckets: 10 } } } });

  const query = { facet: { facets: {
    brands: { type: "string", path: "brand" },
    years: {
      type: "date", path: "added", boundaries: [date(2024), date(2025), date(2026)],
      facets: { brands: { type: "string", path: "brand", aggregations: { total: { type: "sum", path: "price" } } } },
    },
  } } };
  await setQuery(page, query);
  button(page, "Run").click();
  const results = await vi.waitFor(() => {
    const element = page.querySelector<MongFacetResults>("mong-facet-results");
    expect(element?.querySelector(".facet-bars")?.textContent).toContain("Bean Co");
    return element!;
  });
  expect(fetch).toHaveBeenCalledWith("/api/indexes/catalog-id/search-meta", expect.objectContaining({
    method: "POST", body: JSON.stringify({ query }),
  }));
  expect(page.textContent).toContain(`≥${9007199254740993n.toLocaleString()}`);

  const selector = results.querySelector<HTMLSelectElement>('select[aria-label="Facet"]')!;
  selector.selectedIndex = 1;
  selector.dispatchEvent(new Event("change"));
  await results.updateComplete;
  const labels = [...results.querySelectorAll(".facet-columns .facet-mark__label")];
  expect(labels.map((label) => label.textContent)).toEqual(["2024-01-01 – <2025-01-01", "2025-01-01 – <2026-01-01"]);
  button(results, "Table").click();
  await results.updateComplete;
  expect(results.querySelectorAll("tbody tr")).toHaveLength(2);
  button(results, "1 bucket").click();
  await results.updateComplete;
  expect(results.querySelector(".facet-bars")?.textContent).toContain("Bean Co");
  expect(results.querySelector(".facet-mark__value")?.textContent).toBe("8");

  tab(page, "Search").click();
  await page.updateComplete;
  expect(page.querySelector("mong-facet-results")).toBeNull();
  expect(page.querySelector('button[title="Facet and count metadata, with no hits"]')).toBeTruthy();
  tab(page, "Aggregate").click();
  await page.updateComplete;
  expect(page.querySelector<MongQueryEditor>("mong-query-editor")?.getQuery()).toEqual(query);
});

it("offers the Aggregate tab in an embedded search index panel and disables it for vector indexes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  const embedded = await mount(searchIndex.name, true);
  tab(embedded, "Aggregate").click();
  await embedded.updateComplete;
  expect(embedded.querySelector(".facet-field-select")).toBeTruthy();
  expect(embedded.querySelector("#explore-index")).toBeNull();

  embedded.remove();
  const vectors = await mount("vectors");
  expect(tab(vectors, "Aggregate").disabled).toBe(true);
  expect(tab(vectors, "Vector").getAttribute("aria-selected")).toBe("true");
});

it("preserves int64 bounds and places a numeric default bucket after the ranges", () => {
  const boundaries = ["9007199254740992", "9007199254740993", "9007199254740994"].map(($numberLong) => ({ $numberLong }));
  const facet = readFacet("prices", { buckets: [
    { _id: "Other", count: 1 },
    { _id: boundaries[1], count: 4 },
    { _id: boundaries[0], count: 0 },
  ] }, { type: "number", path: "price", boundaries, default: "Other" });
  expect(facet?.buckets.map(({ label, outsideRange }) => [label, outsideRange])).toEqual([
    [`${facetValue(boundaries[0])} – <${facetValue(boundaries[1])}`, false],
    [`${facetValue(boundaries[1])} – <${facetValue(boundaries[2])}`, false],
    ["Other", true],
  ]);
});

it("discards a metadata response after switching indexes", async () => {
  let respond: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { respond = resolve; });
  const fetch = vi.fn((path: string, _options?: RequestInit) =>
    path.endsWith("/search-meta") ? pending : Promise.resolve(new Response(null, { status: 404 })),
  );
  vi.stubGlobal("fetch", fetch);
  const page = await mount();
  tab(page, "Aggregate").click();
  await page.updateComplete;
  await setQuery(page, { exists: { path: "brand" }, count: { type: "total" } });
  button(page, "Run").click();
  const request = fetch.mock.calls.find(([path]) => path.endsWith("/search-meta"));
  expect(request).toBeDefined();

  const indexes = page.querySelector<HTMLSelectElement>("#explore-index")!;
  indexes.value = otherIndex.name;
  indexes.dispatchEvent(new Event("change"));
  await page.updateComplete;
  expect(request?.[1]?.signal?.aborted).toBe(true);
  expect(tab(page, "Aggregate").getAttribute("aria-selected")).toBe("true");
  respond(Response.json({ metadata: { count: { total: 100 } } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(page.querySelector(".results-meta")).toBeNull();
});
