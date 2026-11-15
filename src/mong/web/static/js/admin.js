(() => {
  const FIELD_STATS_PAGE_SIZE = 100;
  const DOCS_SESSION_KEY = "mong.docs.v1";

  const state = {
    indexes: [],
    selectedIndexId: null,
    stats: {
      index: null,
      fields: [],
      nextToken: "",
    },
    docs: {
      mode: "browse",
      pages: [],
      pageIndex: -1,
      nextCursor: null,
      activeCursor: null,
      query: null,
      vector: false,
      loading: false,
    },
  };

  const DEFAULT_SEARCH_DEFINITION = `{
  "mappings": { "dynamic": true },
  "storedSource": true
}`;

  const DEFAULT_VECTOR_DEFINITION = `{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 3,
      "similarity": "cosine"
    }
  ]
}`;

  const DEFAULT_QUERY = `{
  "text": {
    "path": "title",
    "query": "coffee"
  }
}`;

  const DEFAULT_DOCUMENT = `{
  "_id": "coffee-1",
  "title": "Coffee brewing basics",
  "body": "A short guide to better coffee."
}`;

  const PANEL_META = {
    overview: ["Overview", "Instance health and live indexes."],
    indexes: ["Indexes", "Create, edit, and drop search or vector indexes."],
    documents: ["Documents", "Browse, search, explain, upsert, and delete by id or query."],
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let sessionReady = false;
  let allowUnload = false;
  let pendingDocsIndexId = "";

  function toast(message, type = "ok") {
    const host = $("#toast");
    const item = document.createElement("div");
    item.className = `toast__item ${type}`;
    item.textContent = message;
    host.appendChild(item);
    setTimeout(() => item.remove(), 4200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let body = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new Error(`Invalid JSON from ${path}: ${err.message}`);
      }
    }
    if (!response.ok) {
      const message = (body && body.error) || response.statusText || "Request failed";
      throw new Error(message);
    }
    return body;
  }

  function formatBytes(value) {
    const n = Number(value || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatCount(value) {
    if (value == null || value === "") return "—";
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString();
  }

  function formatBytesOrDash(value) {
    if (value == null || value === "") return "—";
    return formatBytes(value);
  }

  function badgeForState(stateName) {
    const raw = (stateName || "unknown").toLowerCase();
    let cls = "";
    if (raw.includes("ready")) cls = "ready";
    else if (raw.includes("build") || raw.includes("pending")) cls = "building";
    else if (raw.includes("fail") || raw.includes("drop")) cls = "failed";
    return `<span class="badge ${cls}">${escapeHtml(stateName || "unknown")}</span>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function shortId(value) {
    const s = String(value || "");
    return s.length > 14 ? `${s.slice(0, 8)}…` : s;
  }

  function fillIndexSelects() {
    const options = state.indexes
      .map((idx) => `<option value="${escapeHtml(idx.index_id)}">${escapeHtml(idx.name)} (${escapeHtml(idx.type)})</option>`)
      .join("") || `<option value="">No indexes</option>`;
    ["#docs-index", "#upsert-index", "#delete-query-index"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      const current = el.value;
      const preferred = sel === "#docs-index" && pendingDocsIndexId ? pendingDocsIndexId : current;
      el.innerHTML = options;
      const pick = [preferred, current].find((value) => value && [...el.options].some((option) => option.value === value));
      if (pick) el.value = pick;
    });
    syncQueryEditor();
  }

  function queryEditor() {
    const editor = $("#docs-query");
    return editor && typeof editor.getQuery === "function" ? editor : null;
  }

  function syncQueryEditor() {
    const editor = queryEditor();
    if (!editor) return;
    editor.indexes = state.indexes;
    editor.mode = state.docs.mode === "vector" ? "vector" : "search";
    editor.indexId = $("#docs-index").value;
  }

  function writeIndexKeyFromSelect() {
    const editor = queryEditor();
    const index = state.indexes.find((item) => item.index_id === $("#docs-index").value);
    if (!editor || !index) return;
    let parsed;
    try {
      parsed = JSON.parse(editor.value);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (!Object.prototype.hasOwnProperty.call(parsed, "index") || parsed.index === index.name) return;
    parsed.index = index.name;
    editor.value = JSON.stringify(parsed, null, 2);
  }

  function renderIndexTable(targetSelector, indexes, { actions = false } = {}) {
    const host = $(targetSelector);
    if (!indexes.length) {
      host.innerHTML = `<div class="empty">No indexes yet.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="table-scroll">
      <table class="table${actions ? " index-table" : ""}">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>State</th>
            <th class="num">Docs</th>
            <th class="num">Size</th>
            <th class="num">Files</th>
            <th class="num">Segments</th>
            <th class="num">Queries</th>
            <th>Revision</th>
            ${actions ? "<th></th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${indexes.map((idx) => {
            const stats = idx.stats || {};
            const docs = stats.documents;
            return `
            <tr data-index-id="${escapeHtml(idx.index_id)}">
              <td><strong>${escapeHtml(idx.name)}</strong><div class="mono muted">${escapeHtml(shortId(idx.index_id))}</div></td>
              <td>${escapeHtml(idx.type)}</td>
              <td>${badgeForState(idx.lifecycle_state)}</td>
              <td class="num">${formatCount(docs)}</td>
              <td class="num">${formatBytesOrDash(stats.size_bytes)}</td>
              <td class="num">${formatCount(stats.files)}</td>
              <td class="num">${formatCount(stats.segments)}</td>
              <td class="num">${formatCount(stats.queries)}</td>
              <td class="mono">${escapeHtml(idx.active_revision)} / ${escapeHtml(idx.desired_revision)}</td>
              ${actions ? `
                <td class="row-actions">
                  <div class="row-actions__group">
                    <button type="button" class="btn ghost" data-action="edit">Edit</button>
                    <button type="button" class="btn ghost" data-action="select">Details</button>
                    <button type="button" class="btn ghost" data-action="stats">Stats</button>
                    ${idx.type === "SEARCH" ? `<button type="button" class="btn ghost" data-action="export-mapping">Export mapping</button>` : ""}
                    <button type="button" class="btn ghost" data-action="drop">Drop</button>
                  </div>
                </td>` : ""}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    `;
  }

  async function loadOverview() {
    const status = await api("/api/status");
    const pill = $("#connection-pill");
    const label = $("#connection-label");
    if (status.management_ready) {
      pill.classList.add("ok");
      pill.classList.remove("bad");
      label.textContent = "Ready";
    } else {
      pill.classList.add("bad");
      pill.classList.remove("ok");
      label.textContent = status.failure_message || "Not ready";
    }

    const indexes = status.indexes || [];
    $("#stats-grid").innerHTML = [
      ["Indexes", indexes.length],
      ["Free disk", formatBytes(status.free_disk_bytes)],
      ["Metrics", status.metrics_count ?? 0],
    ].map(([labelText, value]) => `
      <div class="stat">
        <div class="stat__label">${labelText}</div>
        <div class="stat__value">${escapeHtml(value)}</div>
      </div>
    `).join("");

    state.indexes = indexes;
    renderIndexTable("#overview-indexes", indexes);
    fillIndexSelects();
  }

  async function loadIndexes() {
    const data = await api("/api/indexes");
    state.indexes = data.indexes || [];
    renderIndexTable("#indexes-list", state.indexes, { actions: true });
    renderIndexTable("#overview-indexes", state.indexes);
    fillIndexSelects();
  }

  function definitionEditor() {
    return $("#index-definition");
  }

  function setIndexFormDefaults() {
    $("#index-edit-id").value = "";
    $("#index-name").value = "";
    $("#index-name").disabled = false;
    $("#index-type").disabled = false;
    $("#index-type").value = "SEARCH";
    const editor = definitionEditor();
    editor.mode = "SEARCH";
    editor.index = null;
    editor.value = DEFAULT_SEARCH_DEFINITION;
    $("#index-submit").textContent = "Create index";
  }

  function editIndex(index) {
    state.selectedIndexId = index.index_id;
    $("#index-edit-id").value = index.index_id;
    $("#index-name").value = index.name;
    $("#index-name").disabled = true;
    $("#index-type").value = index.type;
    $("#index-type").disabled = true;
    const editor = definitionEditor();
    editor.mode = index.type === "VECTOR_SEARCH" ? "VECTOR_SEARCH" : "SEARCH";
    editor.index = index;
    editor.value = JSON.stringify(index.definition || {}, null, 2);
    $("#index-submit").textContent = "Update definition";
    showIndexDetail(index);
    toast(`Editing ${index.name}`);
  }

  function showIndexDetail(index) {
    $("#index-detail").hidden = false;
    $("#index-detail-json").textContent = JSON.stringify(index, null, 2);
  }

  async function exportMapping(index) {
    const exported = await api(`/api/indexes/${encodeURIComponent(index.index_id)}/mappings`);
    setIndexFormDefaults();
    $("#index-name").value = `${index.name}_static`;
    $("#index-type").value = "SEARCH";
    const editor = definitionEditor();
    editor.mode = "SEARCH";
    editor.index = index;
    editor.value = JSON.stringify(exported.definition, null, 2);
    toast(`Static mapping for ${index.name} loaded into the form. Create it, then reingest documents.`);
  }

  function measurementTitle(m) {
    if (!m) return "Unavailable";
    const parts = [`${m.method} · ${m.completeness}`];
    if (m.included_components?.length) parts.push(`Includes: ${m.included_components.join(", ")}`);
    if (m.omitted_components?.length) parts.push(`Omits: ${m.omitted_components.join(", ")}`);
    return parts.join("\n");
  }

  function formatMeasurement(m) {
    const title = escapeHtml(measurementTitle(m));
    if (!m || m.value == null) return `<span class="muted" title="${title}">—</span>`;
    const cls = m.completeness === "PARTIAL" ? "measure--partial" : "";
    return `<span class="${cls}" title="${title}">${formatBytes(m.value)}</span>`;
  }

  function formatAge(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }

  function renderStatsSummary(summary) {
    const avg = summary.average_index_bytes_per_document;
    $("#index-stats-summary").innerHTML = [
      ["Documents", formatCount(summary.document_count)],
      ["Lucene docs", formatCount(summary.lucene_document_count)],
      ["Deleted (unmerged)", formatCount(summary.deleted_lucene_document_count)],
      ["Index size", formatBytes(summary.index_size_bytes)],
      ["Directory size", formatMeasurement(summary.directory_size_bytes)],
      ["Bytes / doc", avg == null ? "—" : formatBytes(Math.round(avg))],
    ].map(([labelText, value]) => `
      <div class="stat">
        <div class="stat__label">${labelText}</div>
        <div class="stat__value">${value}</div>
      </div>
    `).join("");
    $("#index-stats-meta").textContent =
      `Generation ${summary.generation_id} · revision ${summary.active_revision} · snapshot age ${formatAge(summary.age_millis)}`;

    const memory = summary.memory || {};
    const rows = [
      ["Reader heap", memory.accounted_reader_heap_bytes],
      ["Writer buffers", memory.accounted_writer_buffer_heap_bytes],
      ["Caches", memory.accounted_cache_heap_bytes],
      ["Vector off-heap (desired)", memory.desired_vector_off_heap_bytes],
    ];
    $("#index-stats-memory").innerHTML = `
      <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Domain</th><th class="num">Bytes</th><th>Method</th><th>Completeness</th><th>Omitted</th></tr></thead>
        <tbody>
          ${rows.map(([name, m]) => `
            <tr>
              <td>${name}</td>
              <td class="num">${formatMeasurement(m)}</td>
              <td class="mono">${escapeHtml(m?.method ?? "—")}</td>
              <td>${escapeHtml(m?.completeness ?? "—")}</td>
              <td class="muted">${escapeHtml((m?.omitted_components || []).join(", ") || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
    `;
  }

  function renderFieldStats(page) {
    const total = Number(page.index_stats?.index_size_bytes || 0);
    const coverage = page.attribution_coverage;
    $("#index-stats-coverage").textContent = [
      `Attributed to fields ${formatBytes(page.total_attributed_disk_bytes)}`
        + (coverage == null ? "" : ` (${(coverage * 100).toFixed(1)}%)`),
      `shared ${formatBytes(page.shared_disk_bytes)}`,
      `unattributed ${formatBytes(page.unattributed_disk_bytes)}`,
    ].join(" · ") + ". * marks partial measurements; hover a value for details.";

    const fields = state.stats.fields;
    $("#index-stats-fields").innerHTML = fields.length ? `
      <div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Types</th>
            <th>Source</th>
            <th class="num">Disk</th>
            <th class="num">Reader heap</th>
            <th class="num">Vector off-heap</th>
          </tr>
        </thead>
        <tbody>
          ${fields.map((field) => {
            const disk = field.attributed_disk_bytes?.value;
            const share = total && disk != null ? Math.min(1, disk / total) : 0;
            const types = [...new Set(field.representations.map((rep) => rep.multi ? `${rep.mapping_type} (${rep.multi})` : rep.mapping_type))];
            const source = [field.configured ? "mapped" : "", field.observed ? "observed" : ""].filter(Boolean).join(", ");
            return `
            <tr>
              <td class="mono">${escapeHtml(field.path)}</td>
              <td>${escapeHtml(types.join(", ") || "—")}</td>
              <td class="muted">${escapeHtml(source || "—")}</td>
              <td class="num">${formatMeasurement(field.attributed_disk_bytes)}<span class="share-bar" title="${(share * 100).toFixed(1)}% of index"><span style="width:${(share * 100).toFixed(1)}%"></span></span></td>
              <td class="num">${formatMeasurement(field.accounted_reader_heap_bytes)}</td>
              <td class="num">${formatMeasurement(field.desired_vector_off_heap_bytes)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    ` : `<div class="empty">No fields reported.</div>`;
    $("#index-stats-more").hidden = !state.stats.nextToken;

    const buckets = [...(page.storage_buckets || [])].sort((a, b) => b.bytes - a.bytes);
    $("#index-stats-buckets").innerHTML = buckets.length ? `
      <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Component</th><th class="num">Bytes</th><th>Owners</th><th>Reason</th></tr></thead>
        <tbody>
          ${buckets.map((bucket) => `
            <tr>
              <td class="mono">${escapeHtml(bucket.component)}${bucket.unattributed ? ` <span class="badge failed">unattributed</span>` : ""}</td>
              <td class="num">${formatBytes(bucket.bytes)}</td>
              <td class="muted">${escapeHtml(bucket.owners.join(", ") || "—")}${bucket.owner_list_complete ? "" : ` (+${bucket.owner_count - bucket.owners.length} more)`}</td>
              <td class="muted">${escapeHtml(bucket.reason || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      </div>
    ` : `<div class="empty">No shared storage.</div>`;
  }

  async function loadIndexStats(index, { refresh = false } = {}) {
    const base = `/api/indexes/${encodeURIComponent(index.index_id)}`;
    state.stats = { index, fields: [], nextToken: "" };
    $("#index-stats").hidden = false;
    $("#index-stats-title").textContent = `Statistics · ${index.name}`;
    $("#index-stats-fields").innerHTML = `<div class="empty">Collecting field statistics…</div>`;

    const refreshParam = refresh ? "&refresh=true" : "";
    const page = await api(`${base}/field-stats?page_size=${FIELD_STATS_PAGE_SIZE}${refreshParam}`);
    const summary = page.index_stats || await api(`${base}/stats${refresh ? "?refresh=true" : ""}`);
    renderStatsSummary(summary);
    if (page.state === "COLLECTING") {
      $("#index-stats-fields").innerHTML = `<div class="empty">Field statistics are still being collected. Refresh in a moment.</div>`;
      return;
    }
    state.stats.fields = page.fields;
    state.stats.nextToken = page.next_page_token || "";
    renderFieldStats(page);
    $("#index-stats").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadMoreFieldStats() {
    const { index, nextToken } = state.stats;
    if (!index || !nextToken) return;
    const page = await api(
      `/api/indexes/${encodeURIComponent(index.index_id)}/field-stats?page_size=${FIELD_STATS_PAGE_SIZE}&page_token=${encodeURIComponent(nextToken)}`,
    );
    state.stats.fields.push(...page.fields);
    state.stats.nextToken = page.next_page_token || "";
    renderFieldStats(page);
  }

  async function dropIndex(index) {
    if (!confirm(`Drop index "${index.name}"? Its documents are removed with the index.`)) return;
    await api(`/api/indexes/${encodeURIComponent(index.index_id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expected_revision: index.desired_revision }),
    });
    toast(`Dropped ${index.name}`);
    if (state.stats.index?.index_id === index.index_id) $("#index-stats-close").click();
    await refreshAll();
  }

  function previewFields(hit) {
    const skip = new Set(["_id", "id", "score", "$search"]);
    return Object.entries(hit)
      .filter(([key]) => !skip.has(key))
      .slice(0, 4);
  }

  function hitId(hit) {
    return hit._id ?? hit.id ?? "";
  }

  function hitScore(hit) {
    return hit.score ?? hit.$search?.score ?? null;
  }

  function documentBody(hit) {
    const nested = hit?.storedSource ?? hit?.stored_source;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      if (nested._id == null && hit._id != null) return { _id: hit._id, ...nested };
      return nested;
    }
    return hit;
  }

  function renderDocCard(hit, index) {
    const browsing = state.docs.mode === "browse";
    const source = browsing ? documentBody(hit) : hit;
    const id = hitId(source) || hitId(hit);
    const score = hitScore(hit);
    const fields = browsing ? [] : previewFields(hit);
    return `
      <article class="doc-card" data-result-index="${index}">
        <div class="doc-card__head">
          <div>
            <div class="doc-card__id">${escapeHtml(id || "(no _id)")}</div>
          </div>
          <div class="doc-card__meta">
            ${!browsing && score !== null && score !== "" ? `<span class="score-pill">${escapeHtml(score)}</span>` : ""}
            ${browsing ? "" : `<button type="button" class="btn ghost" data-action="toggle-json">JSON</button>`}
            ${id !== "" ? `<button type="button" class="btn ghost" data-action="delete-doc" data-delete-id="${escapeHtml(id)}">Delete</button>` : ""}
          </div>
        </div>
        <div class="doc-card__body">
          ${browsing ? "" : `<div class="doc-card__preview">
            ${fields.length
              ? fields.map(([key, value]) => `
                  <div class="doc-kv">
                    <div class="doc-kv__key">${escapeHtml(key)}</div>
                    <div class="doc-kv__val">${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</div>
                  </div>`).join("")
              : `<div class="muted">No preview fields. Open JSON for the full document.</div>`}
          </div>`}
          <pre class="doc-card__json${browsing ? " doc-card__json--full" : ""}"${browsing ? "" : " hidden"}>${escapeHtml(JSON.stringify(source, null, 2))}</pre>
        </div>
      </article>
    `;
  }

  function canGoDocsNext() {
    const page = state.docs.pages[state.docs.pageIndex];
    if (!page) return false;
    if (state.docs.pageIndex < state.docs.pages.length - 1) return true;
    return Boolean(page.cursor_id || page.has_more);
  }

  function updatePager() {
    const pager = $("#docs-pager");
    const page = state.docs.pages[state.docs.pageIndex];
    if (!page) {
      pager.hidden = true;
      return;
    }
    pager.hidden = false;
    const pageNum = state.docs.pageIndex + 1;
    const start = page.count ? (pageNum - 1) * page.page_size + 1 : 0;
    const end = page.count ? start + page.count - 1 : 0;
    const more = canGoDocsNext();
    $("#docs-page-label").textContent = `Page ${pageNum}`;
    $("#docs-pager-meta").textContent = page.count
      ? `Showing ${start}–${end} on this page${more ? " · more available" : " · end of results"}`
      : "No documents on this page";
    $("#docs-prev").disabled = state.docs.pageIndex <= 0 || state.docs.loading;
    $("#docs-next").disabled = !more || state.docs.loading;
  }

  function renderResultsPage() {
    const page = state.docs.pages[state.docs.pageIndex];
    const host = $("#docs-results");
    if (!page) {
      host.innerHTML = `<div class="empty">Choose an index, then run Browse or Search.</div>`;
      updatePager();
      return;
    }
    if (!page.results.length) {
      const planner = page.explain && page.explain_verbosity === "query_planner";
      host.innerHTML = planner
        ? `<div class="empty">Query planner returns the plan and no hits. The plan is in Search meta.</div>`
        : `<div class="empty">No results on this page.</div>`;
    } else {
      host.innerHTML = page.results.map((hit, i) => renderDocCard(hit, i)).join("");
    }
    updatePager();
    renderSearchMeta();
    persistDocsState();
  }

  function searchMetaValue() {
    const pages = state.docs.pages;
    if (!pages.length || state.docs.pageIndex < 0) return { status: "idle", metadata: null, explain: null };
    const current = pages[state.docs.pageIndex] || {};
    const explain = current.explain ?? null;
    if (current.metadata != null) return { status: "ready", metadata: current.metadata, explain };
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      if (pages[i] && pages[i].metadata != null) {
        return { status: "ready", metadata: pages[i].metadata, explain };
      }
    }
    if (explain != null) return { status: "ready", metadata: null, explain };
    return { status: "empty", metadata: null, explain: null };
  }

  function appendJsonSection(parent, title, value) {
    const heading = document.createElement("h3");
    heading.className = "index-stats__heading";
    heading.textContent = title;
    parent.append(heading, isJsonBranch(value) ? jsonBranch(value, 0) : jsonLiteral(value));
  }

  function isJsonBranch(value) {
    if (value === null || typeof value !== "object") return false;
    return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
  }

  function jsonPunct(text) {
    const el = document.createElement("span");
    el.className = "json-punct";
    el.textContent = text;
    return el;
  }

  function jsonKey(key, arrayIndex) {
    const el = document.createElement("span");
    el.className = arrayIndex ? "json-index" : "json-key";
    if (arrayIndex) el.textContent = key;
    else el.textContent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
    return el;
  }

  function jsonLiteral(value) {
    const el = document.createElement("span");
    if (value === null) {
      el.className = "json-null";
      el.textContent = "null";
    } else if (typeof value === "string") {
      el.className = "json-str";
      el.textContent = JSON.stringify(value);
    } else if (typeof value === "number") {
      el.className = "json-num";
      el.textContent = Number.isFinite(value) ? JSON.stringify(value) : String(value);
    } else if (typeof value === "boolean") {
      el.className = "json-bool";
      el.textContent = value ? "true" : "false";
    } else if (Array.isArray(value)) {
      el.className = "json-punct";
      el.textContent = "[]";
    } else if (typeof value === "object") {
      el.className = "json-punct";
      el.textContent = "{}";
    } else {
      el.className = "json-punct";
      el.textContent = String(value);
    }
    return el;
  }

  function jsonBranch(value, depth) {
    const isArray = Array.isArray(value);
    const details = document.createElement("details");
    details.className = "json-node";
    details.open = depth < 3;
    const summary = document.createElement("summary");
    const preview = document.createElement("span");
    preview.className = "json-preview";
    const count = isArray ? value.length : Object.keys(value).length;
    preview.textContent = isArray
      ? `${count} ${count === 1 ? "item" : "items"}`
      : `${count} ${count === 1 ? "key" : "keys"}`;
    summary.append(jsonPunct(isArray ? "[" : "{"), preview);
    const children = document.createElement("div");
    children.className = "json-children";
    const entries = isArray ? value.map((item, index) => [String(index), item, true]) : Object.entries(value).map(([key, item]) => [key, item, false]);
    for (const [key, item, arrayIndex] of entries) {
      children.append(jsonProperty(key, item, depth + 1, arrayIndex));
    }
    const close = document.createElement("div");
    close.className = "json-close";
    close.append(jsonPunct(isArray ? "]" : "}"));
    details.append(summary, children, close);
    return details;
  }

  function jsonProperty(key, value, depth, arrayIndex) {
    if (!isJsonBranch(value)) {
      const row = document.createElement("div");
      row.className = "json-leaf";
      row.append(jsonKey(key, arrayIndex), jsonPunct(":"), jsonLiteral(value));
      return row;
    }
    const branch = jsonBranch(value, depth);
    branch.querySelector("summary").prepend(jsonKey(key, arrayIndex), jsonPunct(":"));
    return branch;
  }

  function jsonNote(text) {
    const note = document.createElement("p");
    note.className = "hint json-tree__note";
    note.textContent = text;
    return note;
  }

  function renderSearchMeta() {
    const panel = $("#docs-meta");
    const tree = $("#docs-meta-tree");
    const actions = $("#docs-meta-actions");
    if (!panel || !tree || !actions) return;
    const searching = state.docs.mode === "search" || state.docs.mode === "vector";
    if (!searching) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    renderSearchLatency();
    const view = searchMetaValue();
    const signature = view.status === "ready" ? JSON.stringify({ metadata: view.metadata, explain: view.explain }) : view.status;
    if (tree.dataset.signature === signature) {
      actions.hidden = view.status !== "ready" || !tree.querySelector("details");
      return;
    }
    tree.dataset.signature = signature;
    tree.replaceChildren();
    if (view.status === "idle") {
      tree.append(jsonNote("Run a search to see count, facets, and other metadata."));
      actions.hidden = true;
      return;
    }
    if (view.status === "empty") {
      tree.append(jsonNote("This search did not return metadata."));
      actions.hidden = true;
      return;
    }
    if (view.explain != null) {
      if (view.metadata != null) appendJsonSection(tree, "Metadata", view.metadata);
      appendJsonSection(tree, "Explain", view.explain);
    } else {
      tree.append(isJsonBranch(view.metadata) ? jsonBranch(view.metadata, 0) : jsonLiteral(view.metadata));
    }
    actions.hidden = !tree.querySelector("details");
  }

  function formatLatency(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1000) {
      const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
      return `${value.toFixed(digits)} ms`;
    }
    return `${(value / 1000).toFixed(2)} s`;
  }

  function renderSearchLatency() {
    const host = $("#docs-meta-latency");
    const mongotRow = $("#docs-meta-mongot-row");
    if (!host || !mongotRow) return;
    const page = state.docs.pages[state.docs.pageIndex];
    const endToEnd = page?.e2e_latency_ms;
    const mongot = page?.latency_ms;
    if (!page || (endToEnd == null && mongot == null)) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    $("#docs-meta-e2e").textContent = formatLatency(endToEnd);
    mongotRow.hidden = mongot == null;
    $("#docs-meta-mongot").textContent = formatLatency(mongot);
  }

  function appendEndToEndLatency(result, millis) {
    if (!result || typeof result !== "object") return;
    const metadata = result.metadata;
    if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
      result.metadata = { endToEndLatencyMillis: millis };
      return;
    }
    metadata.endToEndLatencyMillis = millis;
  }

  async function timedQuery(path, options) {
    const started = performance.now();
    const result = await api(path, options);
    if (result && typeof result === "object") {
      const millis = Math.round(performance.now() - started);
      result.e2e_latency_ms = millis;
      appendEndToEndLatency(result, millis);
    }
    return result;
  }

  async function killActiveCursor() {
    const cursor = state.docs.activeCursor;
    state.docs.activeCursor = null;
    state.docs.nextCursor = null;
    if (!cursor) return;
    try {
      await api(`/api/query/cursors/${encodeURIComponent(cursor)}`, { method: "DELETE" });
    } catch {
      // Cursor may already be exhausted; ignore.
    }
  }

  function readDocsQuery() {
    const editor = queryEditor();
    if (editor) return editor.getQuery();
    try {
      return JSON.parse($("#docs-query").value || "{}");
    } catch {
      throw new Error("Query must be valid JSON");
    }
  }

  function setDocsMode(mode) {
    state.docs.mode = mode;
    $$("#docs-mode-tabs .mode-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    const queryWrap = $("#docs-query-wrap");
    const runBtn = $("#run-docs-query");
    const hint = $("#docs-query-hint");

    if (mode === "browse") {
      queryWrap.hidden = true;
      queryWrap.setAttribute("hidden", "");
      runBtn.textContent = "Browse";
      renderSearchMeta();
      persistDocsState();
      return;
    }

    queryWrap.hidden = false;
    queryWrap.removeAttribute("hidden");
    runBtn.textContent = mode === "vector" ? "Vector search" : "Search";

    if (mode === "search") {
      hint.textContent = "JSON search expression. Ctrl+Space completes operators (including join in compound.filter / mustNot), fields, and index names. Ctrl+Enter runs it. Alt+Shift+F indents.";
      if ($("#docs-query").dataset.autofill !== "custom") {
        $("#docs-query").value = DEFAULT_QUERY;
        $("#docs-query").dataset.autofill = "search";
      }
      syncQueryEditor();
      renderSearchMeta();
      persistDocsState();
      return;
    }

    hint.textContent = "Vector search expression. queryVector length must match numDimensions. filter is an MQL document on filter fields. Alt+Shift+F indents.";
    if ($("#docs-query").dataset.autofill !== "custom") {
      $("#docs-query").value = `{
  "path": "embedding",
  "queryVector": [0.1, 0.2, 0.3],
  "numCandidates": 50,
  "limit": 10
}`;
      $("#docs-query").dataset.autofill = "vector";
    }
    syncQueryEditor();
    renderSearchMeta();
    persistDocsState();
  }

  async function startDocsQuery() {
    const indexId = $("#docs-index").value;
    if (!indexId) throw new Error("Select an index first");

    const pageSize = Number($("#docs-page-size").value || 25);
    const mode = state.docs.mode;
    const vector = mode === "vector";
    const browsing = mode === "browse";
    const query = browsing ? null : readDocsQuery();
    const path = browsing
      ? `/api/indexes/${encodeURIComponent(indexId)}/browse`
      : `/api/indexes/${encodeURIComponent(indexId)}/search`;

    state.docs.loading = true;
    updatePager();
    await killActiveCursor();

    const body = {
      page_size: pageSize,
      page: 1,
      vector,
    };
    if (!browsing) {
      body.query = query;
      const explain = $("#docs-explain")?.value || "";
      if (explain) body.explain = explain;
    }

    const result = await timedQuery(path, {
      method: "POST",
      body: JSON.stringify(body),
    });

    state.docs.pages = [result];
    state.docs.pageIndex = 0;
    state.docs.query = query;
    state.docs.vector = vector;
    state.docs.nextCursor = result.cursor_id || null;
    state.docs.activeCursor = result.cursor_id || null;
    state.docs.loading = false;
    renderResultsPage();
    if (result.explain && result.explain_verbosity === "query_planner") toast("Query plan ready");
    else toast(`${result.count} on page 1`);
  }

  async function docsNextPage() {
    const current = state.docs.pages[state.docs.pageIndex];
    if (!current) return;

    if (state.docs.pageIndex < state.docs.pages.length - 1) {
      state.docs.pageIndex += 1;
      const cached = state.docs.pages[state.docs.pageIndex];
      state.docs.nextCursor = cached.cursor_id || null;
      renderResultsPage();
      return;
    }

    const cursorId = state.docs.nextCursor || current.cursor_id;
    if (!cursorId) return;

    state.docs.loading = true;
    updatePager();
    const pageSize = Number($("#docs-page-size").value || current.page_size || 25);
    const result = await timedQuery("/api/query/more", {
      method: "POST",
      body: JSON.stringify({
        cursor_id: cursorId,
        index_id: $("#docs-index").value,
        page_size: pageSize,
        page: state.docs.pageIndex + 2,
      }),
    });
    state.docs.pages.push(result);
    state.docs.pageIndex = state.docs.pages.length - 1;
    state.docs.nextCursor = result.cursor_id || null;
    state.docs.activeCursor = result.cursor_id || null;
    state.docs.loading = false;
    renderResultsPage();
  }

  function docsPrevPage() {
    if (state.docs.pageIndex <= 0) return;
    state.docs.pageIndex -= 1;
    renderResultsPage();
  }

  async function refreshAll() {
    await loadOverview();
    await loadIndexes();
  }

  function switchPanel(name) {
    if (!PANEL_META[name]) return;
    $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
    $$("#nav button").forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === name));
    const [title, subtitle] = PANEL_META[name];
    $("#panel-title").textContent = title;
    $("#panel-subtitle").textContent = subtitle;
    persistDocsState();
  }

  function bindEvents() {
    $$("#nav button").forEach((btn) => {
      btn.addEventListener("click", () => switchPanel(btn.dataset.panel));
    });

    $("#refresh-overview").addEventListener("click", () => loadOverview().catch((e) => toast(e.message, "error")));
    $("#refresh-indexes").addEventListener("click", () => loadIndexes().catch((e) => toast(e.message, "error")));

    $("#index-type").addEventListener("change", (event) => {
      if ($("#index-edit-id").value) return;
      const vector = event.target.value === "VECTOR_SEARCH";
      const editor = definitionEditor();
      editor.mode = vector ? "VECTOR_SEARCH" : "SEARCH";
      editor.value = vector ? DEFAULT_VECTOR_DEFINITION : DEFAULT_SEARCH_DEFINITION;
    });

    $("#index-reset").addEventListener("click", setIndexFormDefaults);

    $("#index-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      let definition;
      try {
        definition = definitionEditor().getDefinition();
      } catch (err) {
        toast(err.message, "error");
        return;
      }

      const editId = $("#index-edit-id").value;
      try {
        if (editId) {
          const current = state.indexes.find((idx) => idx.index_id === editId);
          if (!confirm("Updating the definition rebuilds an empty index. Documents in it are dropped and must be reingested.")) {
            return;
          }
          await api(`/api/indexes/${encodeURIComponent(editId)}`, {
            method: "PUT",
            body: JSON.stringify({
              definition,
              expected_revision: current?.desired_revision,
            }),
          });
          toast("Index rebuilt empty. Reingest documents.");
        } else {
          await api("/api/indexes", {
            method: "POST",
            body: JSON.stringify({
              name: $("#index-name").value.trim(),
              type: $("#index-type").value,
              definition,
            }),
          });
          toast("Index create accepted");
        }
        setIndexFormDefaults();
        await refreshAll();
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("#indexes-list").addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const row = button.closest("tr[data-index-id]");
      const index = state.indexes.find((idx) => idx.index_id === row.dataset.indexId);
      if (!index) return;
      try {
        if (button.dataset.action === "edit") editIndex(index);
        if (button.dataset.action === "select") {
          const fresh = await api(`/api/indexes/${encodeURIComponent(index.index_id)}`);
          showIndexDetail(fresh);
        }
        if (button.dataset.action === "stats") await loadIndexStats(index);
        if (button.dataset.action === "export-mapping") await exportMapping(index);
        if (button.dataset.action === "drop") await dropIndex(index);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("#index-stats-refresh").addEventListener("click", () => {
      if (!state.stats.index) return;
      loadIndexStats(state.stats.index, { refresh: true }).catch((e) => toast(e.message, "error"));
    });
    $("#index-stats-more").addEventListener("click", () => {
      loadMoreFieldStats().catch((e) => toast(e.message, "error"));
    });
    $("#index-stats-close").addEventListener("click", () => {
      state.stats = { index: null, fields: [], nextToken: "" };
      $("#index-stats").hidden = true;
    });

    $$("#docs-mode-tabs .mode-tab").forEach((btn) => {
      btn.addEventListener("click", () => setDocsMode(btn.dataset.mode));
    });
    $("#docs-meta-expand").addEventListener("click", () => {
      $$("#docs-meta-tree details").forEach((node) => {
        node.open = true;
      });
    });
    $("#docs-meta-collapse").addEventListener("click", () => {
      $$("#docs-meta-tree details").forEach((node) => {
        node.open = false;
      });
    });
    $("#docs-index").addEventListener("change", () => {
      pendingDocsIndexId = "";
      syncQueryEditor();
      writeIndexKeyFromSelect();
      persistDocsState();
    });
    $("#docs-query").addEventListener("index-change", (event) => {
      const select = $("#docs-index");
      const indexId = event.detail?.indexId;
      if (!indexId || ![...select.options].some((option) => option.value === indexId)) return;
      select.value = indexId;
      const editor = queryEditor();
      if (editor) editor.indexId = indexId;
    });
    $("#docs-query").addEventListener("run", () => {
      startDocsQuery().catch((err) => {
        state.docs.loading = false;
        updatePager();
        toast(err.message, "error");
      });
    });
    $("#docs-query").addEventListener("input", () => {
      $("#docs-query").dataset.autofill = "custom";
      persistDocsState();
    });
    $("#docs-query").addEventListener("formatted", () => persistDocsState());
    $("#docs-query-indent").addEventListener("click", () => {
      const editor = queryEditor();
      if (!editor) return;
      editor.indent();
      editor.focus();
    });
    $("#run-docs-query").addEventListener("click", () => {
      startDocsQuery().catch((e) => {
        state.docs.loading = false;
        updatePager();
        toast(e.message, "error");
      });
    });
    $("#docs-refresh").addEventListener("click", () => {
      startDocsQuery().catch((e) => {
        state.docs.loading = false;
        updatePager();
        toast(e.message, "error");
      });
    });
    $("#docs-prev").addEventListener("click", () => docsPrevPage());
    $("#docs-next").addEventListener("click", () => {
      docsNextPage().catch((e) => {
        state.docs.loading = false;
        updatePager();
        toast(e.message, "error");
      });
    });
    $("#docs-page-size").addEventListener("change", () => {
      persistDocsState();
      if (state.docs.pages.length) {
        startDocsQuery().catch((e) => toast(e.message, "error"));
      }
    });
    $("#docs-explain")?.addEventListener("change", () => persistDocsState());

    function syncDeleteQueryForm() {
      const selector = $("#delete-query-selector")?.value || "search";
      const wrap = $("#delete-query-text-wrap");
      const hint = $("#delete-query-hint");
      const dry = $("#delete-query-dry")?.checked !== false;
      const submit = $("#delete-query-submit");
      if (wrap) wrap.hidden = selector === "match_all";
      if (hint) {
        hint.textContent = selector === "vector"
          ? "MQL metadata filter for a vector index. This is the filter document, not a vector search expression."
          : "Search expression. An optional index key is ignored.";
      }
      if (submit) {
        submit.textContent = dry ? "Count matches" : "Delete matches";
        submit.classList.toggle("secondary", dry);
        submit.classList.toggle("danger", !dry);
      }
    }
    syncDeleteQueryForm();
    $("#delete-query-selector")?.addEventListener("change", syncDeleteQueryForm);
    $("#delete-query-dry")?.addEventListener("change", syncDeleteQueryForm);

    $("#upsert-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      let document;
      try {
        document = JSON.parse($("#upsert-document").value);
      } catch {
        toast("Document must be valid JSON", "error");
        return;
      }
      try {
        const indexId = $("#upsert-index").value;
        if (!indexId) {
          toast("Select an index first", "error");
          return;
        }
        const result = await api(`/api/indexes/${encodeURIComponent(indexId)}/documents`, {
          method: "POST",
          body: JSON.stringify({ documents: [document] }),
        });
        toast(`Indexed ${result.indexed_count} document(s)`);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("#delete-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const indexId = $("#upsert-index").value;
      const id = $("#delete-id").value.trim();
      if (!indexId || !id) return;
      try {
        const result = await api(
          `/api/indexes/${encodeURIComponent(indexId)}/documents/${encodeURIComponent(id)}`,
          { method: "DELETE", body: JSON.stringify({ id }) },
        );
        toast(`Processed ${result.processed_count} id(s)`);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $("#delete-query-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const indexId = $("#delete-query-index").value;
      if (!indexId) {
        toast("Select an index first", "error");
        return;
      }
      const selector = $("#delete-query-selector").value;
      const dry = $("#delete-query-dry").checked;
      const rawMax = $("#delete-query-max").value.trim();
      const maxMatches = rawMax === "" ? 0 : Number(rawMax);
      if (!Number.isInteger(maxMatches) || maxMatches < 0) {
        toast("Max matches must be a non-negative integer", "error");
        return;
      }
      const body = { dry_run: dry, max_matches: maxMatches };
      if (selector === "match_all") {
        body.match_all = true;
      } else {
        try {
          body.query = JSON.parse($("#delete-query").value || "{}");
        } catch {
          toast("Predicate must be valid JSON", "error");
          return;
        }
        if (!body.query || typeof body.query !== "object" || Array.isArray(body.query)) {
          toast("Predicate must be a JSON object", "error");
          return;
        }
        body.vector = selector === "vector";
      }
      if (!dry) {
        const limit = maxMatches || 10000;
        const ok = confirm(`Delete up to ${limit} matching documents from this index? A failed call can still remove a prefix.`);
        if (!ok) return;
      }
      try {
        const result = await api(`/api/indexes/${encodeURIComponent(indexId)}/delete-by-query`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const matched = result.matched_count ?? 0;
        toast(dry ? `Dry run matched ${matched}` : `Matched ${matched}, processed ${result.processed_count}`);
        if (!dry && $("#docs-index").value === indexId && state.docs.pages.length) {
          await startDocsQuery();
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });

    window.addEventListener("keydown", (event) => {
      const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "r");
      if (!reload || !docsSessionDirty()) return;
      event.preventDefault();
      if (!confirm("Reload this page? The search query and results are saved in this tab.")) return;
      allowUnload = true;
      persistDocsState();
      window.location.reload();
    });
    window.addEventListener("beforeunload", (event) => {
      persistDocsState();
      if (allowUnload || !docsSessionDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    });
    window.addEventListener("pagehide", () => persistDocsState());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistDocsState();
    });

    $("#docs-results").addEventListener("click", async (event) => {
      const toggle = event.target.closest("button[data-action='toggle-json']");
      if (toggle) {
        const card = toggle.closest(".doc-card");
        const json = card.querySelector(".doc-card__json");
        json.hidden = !json.hidden;
        return;
      }

      const button = event.target.closest("button[data-action='delete-doc']");
      if (!button) return;
      const indexId = $("#docs-index").value;
      try {
        const result = await api(
          `/api/indexes/${encodeURIComponent(indexId)}/documents/${encodeURIComponent(button.dataset.deleteId)}`,
          { method: "DELETE", body: JSON.stringify({ id: button.dataset.deleteId }) },
        );
        toast(`Processed ${result.processed_count} id(s)`);
        await startDocsQuery();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  function readDocsSession() {
    try {
      const raw = sessionStorage.getItem(DOCS_SESSION_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
      if (!["browse", "search", "vector"].includes(saved.mode)) saved.mode = "browse";
      if (!PANEL_META[saved.panel]) saved.panel = "";
      return saved;
    } catch {
      return null;
    }
  }

  function persistDocsState() {
    if (!sessionReady) return;
    const editor = $("#docs-query");
    const payload = {
      panel: $("#nav button.active")?.dataset.panel || "overview",
      mode: state.docs.mode,
      indexId: pendingDocsIndexId || $("#docs-index")?.value || "",
      pageSize: $("#docs-page-size")?.value || "25",
      query: editor ? editor.value : "",
      autofill: editor?.dataset.autofill || "",
      explain: $("#docs-explain")?.value || "",
      pageIndex: state.docs.pageIndex,
      nextCursor: state.docs.nextCursor,
      activeCursor: state.docs.activeCursor,
      pages: state.docs.pages,
    };
    const slim = { ...payload, pages: [], pageIndex: -1, nextCursor: null, activeCursor: null };
    for (const attempt of [payload, slim]) {
      try {
        sessionStorage.setItem(DOCS_SESSION_KEY, JSON.stringify(attempt));
        return;
      } catch {
        // Storage can reject a large result set. The next attempt keeps the query only.
      }
    }
  }

  function docsSessionDirty() {
    const editor = $("#docs-query");
    if (editor?.dataset.autofill === "custom" && editor.value.trim()) return true;
    return state.docs.pageIndex >= 0 && state.docs.pages.length > 0;
  }

  function restoreDocsResults(saved) {
    const pages = Array.isArray(saved.pages)
      ? saved.pages.filter((page) => page && typeof page === "object" && Array.isArray(page.results))
      : [];
    if (!pages.length) return;
    state.docs.pages = pages;
    const requested = Number.isInteger(saved.pageIndex) ? saved.pageIndex : 0;
    state.docs.pageIndex = Math.min(Math.max(requested, 0), pages.length - 1);
    state.docs.nextCursor = saved.nextCursor || pages[state.docs.pageIndex]?.cursor_id || null;
    state.docs.activeCursor = saved.activeCursor || state.docs.nextCursor;
    state.docs.loading = false;
    renderResultsPage();
  }

  function applySavedDocsEditor(saved) {
    const editor = $("#docs-query");
    const pageSize = $("#docs-page-size");
    if (saved.pageSize && pageSize && [...pageSize.options].some((option) => option.value === String(saved.pageSize))) {
      pageSize.value = String(saved.pageSize);
    }
    const explain = $("#docs-explain");
    if (explain && typeof saved.explain === "string" && [...explain.options].some((option) => option.value === saved.explain)) {
      explain.value = saved.explain;
    }
    pendingDocsIndexId = typeof saved.indexId === "string" ? saved.indexId : "";
    if (saved.autofill && editor) editor.dataset.autofill = saved.autofill;
    setDocsMode(saved.mode || "browse");
    if (editor && typeof saved.query === "string") editor.value = saved.query;
    if (saved.autofill && editor) editor.dataset.autofill = saved.autofill;
    restoreDocsResults(saved);
  }

  async function boot() {
    await Promise.all([
      customElements.whenDefined("mong-query-editor"),
      customElements.whenDefined("mong-definition-editor"),
    ]);
    definitionEditor().mode = "SEARCH";
    definitionEditor().value = DEFAULT_SEARCH_DEFINITION;
    $("#upsert-document").value = DEFAULT_DOCUMENT;
    const saved = readDocsSession();
    if (saved) applySavedDocsEditor(saved);
    else setDocsMode("browse");
    bindEvents();
    sessionReady = true;
    try {
      await refreshAll();
    } catch (err) {
      $("#connection-pill").classList.add("bad");
      $("#connection-label").textContent = "Disconnected";
      toast(err.message, "error");
    }
    if (saved?.panel) switchPanel(saved.panel);
    persistDocsState();
  }

  boot();
})();
