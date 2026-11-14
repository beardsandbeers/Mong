(() => {
  const state = {
    indexes: [],
    selectedIndexId: null,
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
    documents: ["Documents", "Browse, search, upsert, and delete by id."],
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
    ["#docs-index", "#upsert-index"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      const current = el.value;
      el.innerHTML = options;
      if (current && [...el.options].some((o) => o.value === current)) el.value = current;
    });
  }

  function renderIndexTable(targetSelector, indexes, { actions = false } = {}) {
    const host = $(targetSelector);
    if (!indexes.length) {
      host.innerHTML = `<div class="empty">No indexes yet.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="table-scroll">
      <table class="table">
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
                <td class="actions">
                  <button type="button" class="btn ghost" data-action="edit">Edit</button>
                  <button type="button" class="btn ghost" data-action="select">Details</button>
                  <button type="button" class="btn ghost" data-action="drop">Drop</button>
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

  function setIndexFormDefaults() {
    $("#index-edit-id").value = "";
    $("#index-name").value = "";
    $("#index-name").disabled = false;
    $("#index-type").disabled = false;
    $("#index-type").value = "SEARCH";
    $("#index-definition").value = DEFAULT_SEARCH_DEFINITION;
    $("#index-submit").textContent = "Create index";
  }

  function editIndex(index) {
    state.selectedIndexId = index.index_id;
    $("#index-edit-id").value = index.index_id;
    $("#index-name").value = index.name;
    $("#index-name").disabled = true;
    $("#index-type").value = index.type;
    $("#index-type").disabled = true;
    $("#index-definition").value = JSON.stringify(index.definition || {}, null, 2);
    $("#index-submit").textContent = "Update definition";
    showIndexDetail(index);
    toast(`Editing ${index.name}`);
  }

  function showIndexDetail(index) {
    $("#index-detail").hidden = false;
    $("#index-detail-json").textContent = JSON.stringify(index, null, 2);
  }

  async function dropIndex(index) {
    if (!confirm(`Drop index "${index.name}"? Its documents are removed with the index.`)) return;
    await api(`/api/indexes/${encodeURIComponent(index.index_id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expected_revision: index.desired_revision }),
    });
    toast(`Dropped ${index.name}`);
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
      host.innerHTML = `<div class="empty">No results on this page.</div>`;
    } else {
      host.innerHTML = page.results.map((hit, i) => renderDocCard(hit, i)).join("");
    }
    updatePager();
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
      return;
    }

    queryWrap.hidden = false;
    queryWrap.removeAttribute("hidden");
    runBtn.textContent = mode === "vector" ? "Vector search" : "Search";

    if (mode === "search") {
      hint.textContent = "Mongot search expression, for example text on a field path.";
      if ($("#docs-query").dataset.autofill !== "custom") {
        $("#docs-query").value = DEFAULT_QUERY;
        $("#docs-query").dataset.autofill = "search";
      }
      return;
    }

    hint.textContent = "Vector search expression body sent through vectorSearch.";
    if ($("#docs-query").dataset.autofill !== "custom") {
      $("#docs-query").value = `{
  "vector": {
    "path": "embedding",
    "queryVector": [0.1, 0.2, 0.3],
    "numCandidates": 50,
    "limit": 10
  }
}`;
      $("#docs-query").dataset.autofill = "vector";
    }
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
    if (!browsing) body.query = query;

    const result = await api(path, {
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
    toast(`${result.count} on page 1`);
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
    const result = await api("/api/query/more", {
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
    $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
    $$("#nav button").forEach((btn) => btn.classList.toggle("active", btn.dataset.panel === name));
    const [title, subtitle] = PANEL_META[name];
    $("#panel-title").textContent = title;
    $("#panel-subtitle").textContent = subtitle;
  }

  function bindEvents() {
    $$("#nav button").forEach((btn) => {
      btn.addEventListener("click", () => switchPanel(btn.dataset.panel));
    });

    $("#refresh-overview").addEventListener("click", () => loadOverview().catch((e) => toast(e.message, "error")));
    $("#refresh-indexes").addEventListener("click", () => loadIndexes().catch((e) => toast(e.message, "error")));

    $("#index-type").addEventListener("change", (event) => {
      if ($("#index-edit-id").value) return;
      $("#index-definition").value = event.target.value === "VECTOR_SEARCH"
        ? DEFAULT_VECTOR_DEFINITION
        : DEFAULT_SEARCH_DEFINITION;
    });

    $("#index-reset").addEventListener("click", setIndexFormDefaults);

    $("#index-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      let definition;
      try {
        definition = JSON.parse($("#index-definition").value);
      } catch {
        toast("Definition must be valid JSON", "error");
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
        if (button.dataset.action === "drop") await dropIndex(index);
      } catch (err) {
        toast(err.message, "error");
      }
    });

    $$("#docs-mode-tabs .mode-tab").forEach((btn) => {
      btn.addEventListener("click", () => setDocsMode(btn.dataset.mode));
    });
    $("#docs-query").addEventListener("input", () => {
      $("#docs-query").dataset.autofill = "custom";
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
      if (state.docs.pages.length) {
        startDocsQuery().catch((e) => toast(e.message, "error"));
      }
    });

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

  async function boot() {
    $("#index-definition").value = DEFAULT_SEARCH_DEFINITION;
    $("#upsert-document").value = DEFAULT_DOCUMENT;
    setDocsMode("browse");
    bindEvents();
    try {
      await refreshAll();
    } catch (err) {
      $("#connection-pill").classList.add("bad");
      $("#connection-label").textContent = "Disconnected";
      toast(err.message, "error");
    }
  }

  boot();
})();
