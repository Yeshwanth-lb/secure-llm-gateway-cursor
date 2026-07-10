// ===== CONTROL-PLANE CONSOLE (webpage) ======================================
// Self-contained HTML (zero deps, no build, no external assets) served at
// GET /mcp (browser Accept), GET /, and GET /console. Three tabs:
//   Rules     — every regex rule with a live enable/disable toggle, source
//               badge, pattern, add-custom-rule form, remove (non-default).
//   Allowlist — exception patterns that are never redacted; add/toggle/remove.
//   Traffic   — the live traffic inspector (polls /logs): what got redacted,
//               matched-rule counts, and post-redaction snapshots.
// All state is live via /api/* + /logs, shared in-process with the proxy.
// Client script uses string concatenation (no template literals) so this outer
// template literal stays clean. Snapshots are already redacted; the page never
// receives or renders raw PII.

export const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Secure LLM Gateway — Console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0b0e14; color: #cdd6f4; }
  header { position: sticky; top: 0; z-index: 3; display: flex; align-items: center;
           gap: 14px; padding: 12px 18px; background: #11151f; border-bottom: 1px solid #1f2430; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; color: #89b4fa; }
  .spacer { flex: 1; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 6px 14px; border-radius: 6px; cursor: pointer; color: #a6adc8;
         border: 1px solid transparent; }
  .tab.active { background: #1e2430; color: #cdd6f4; border-color: #2a3040; }
  .stat { color: #6c7086; } .stat b { color: #cdd6f4; }
  main { padding: 16px 18px; }
  section { display: none; } section.active { display: block; }
  button { font: inherit; color: #cdd6f4; background: #1e2430; border: 1px solid #2a3040;
           border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { background: #262d3b; }
  button.danger { color: #f38ba8; border-color: #45303a; }
  input { font: inherit; color: #cdd6f4; background: #10141d; border: 1px solid #2a3040;
          border-radius: 6px; padding: 6px 9px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1a1f2b; vertical-align: top; }
  th { color: #7f849c; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  code { background: #10141d; border: 1px solid #1c2230; border-radius: 5px; padding: 1px 6px;
         color: #f9e2af; word-break: break-all; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .src-default { background: #6c708622; color: #a6adc8; }
  .src-custom-ui, .src-custom-env, .src-custom-file, .src-allow-ui, .src-allow-env
    { background: #cba6f722; color: #cba6f7; }
  .rule { background: #89b4fa22; color: #89b4fa; margin-right: 4px; }
  .ok { color: #a6e3a1; } .warn { color: #f9e2af; } .err { color: #f38ba8; }
  .prov { color: #cba6f7; } .pii-yes { background: #f38ba822; color: #f38ba8; }
  .pii-no { background: #6c708622; color: #6c7086; }
  .form { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; align-items: center; }
  .msg { color: #f38ba8; min-height: 18px; margin: 4px 0; }
  .hint { color: #6c7086; margin: 2px 0 10px; }
  /* toggle switch */
  .sw { position: relative; display: inline-block; width: 38px; height: 20px; }
  .sw input { display: none; }
  .sw span { position: absolute; inset: 0; background: #313244; border-radius: 999px; transition: .15s; }
  .sw span::before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px;
                     background: #cdd6f4; border-radius: 50%; transition: .15s; }
  .sw input:checked + span { background: #a6e3a1; }
  .sw input:checked + span::before { transform: translateX(18px); }
  tr.row { cursor: pointer; } tr.row:hover { background: #121723; }
  .detail td { background: #0a0d13; }
  .snap { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .snap h4 { margin: 0 0 4px; color: #7f849c; font-weight: 500; }
  .snap pre { margin: 0; padding: 10px; background: #10141d; border: 1px solid #1c2230; border-radius: 6px;
              max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #bac2de; }
  .empty { padding: 30px; text-align: center; color: #6c7086; }
</style>
</head>
<body>
<header>
  <h1>Gateway Console</h1>
  <div class="tabs">
    <div class="tab active" data-tab="rules">Rules</div>
    <div class="tab" data-tab="allow">Allowlist</div>
    <div class="tab" data-tab="models">Model Policy</div>
    <div class="tab" data-tab="traffic">Traffic Inspector</div>
  </div>
  <div class="spacer"></div>
  <span class="stat" id="hdr"></span>
</header>
<main>
  <section id="rules" class="active">
    <div class="hint">Toggle a rule to enable/disable it on the live proxy instantly. Custom rules merge ahead of defaults.</div>
    <div class="form">
      <input id="r-name" placeholder="RULE_NAME" size="16" />
      <input id="r-pat" placeholder="regex pattern (e.g. EMP-\\\\d{6})" size="34" />
      <input id="r-flags" placeholder="flags (gi)" size="8" />
      <button id="r-add">+ add custom rule</button>
    </div>
    <div class="msg" id="r-msg"></div>
    <table><thead><tr><th>on</th><th>name</th><th>source</th><th>pattern</th><th>flags</th><th></th></tr></thead>
      <tbody id="r-rows"></tbody></table>
  </section>

  <section id="allow">
    <div class="hint">Allowlisted matches are never redacted — an exception carved out of the rules above (e.g. a test email, an internal IP range).</div>
    <div class="form">
      <input id="a-pat" placeholder="regex pattern (e.g. test@example\\\\.com)" size="34" />
      <input id="a-flags" placeholder="flags (i)" size="8" />
      <button id="a-add">+ add allowlist entry</button>
    </div>
    <div class="msg" id="a-msg"></div>
    <table><thead><tr><th>on</th><th>pattern</th><th>flags</th><th>source</th><th></th></tr></thead>
      <tbody id="a-rows"></tbody></table>
  </section>

  <section id="models">
    <div class="hint">Block requests by model. A blocked model is rejected with 403 at the proxy — the request never leaves your machine. Matches the model id in the request (substring). "All Claude models" blocks every Claude Code model at once.</div>
    <table><thead><tr><th>block</th><th>model</th><th>matches id contains</th></tr></thead>
      <tbody id="m-rows"></tbody></table>
  </section>

  <section id="traffic">
    <div class="form">
      <label><input type="checkbox" id="onlyPii" /> only PII</label>
      <label><input type="checkbox" id="clean" /> strip Claude boilerplate (user prompt + output only)</label>
      <label><input type="checkbox" id="auto" checked /> auto-refresh 2s</label>
      <button id="t-refresh">refresh</button>
    </div>
    <table><thead><tr>
      <th>time</th><th>provider</th><th>method</th><th>path</th><th>status</th>
      <th>stream</th><th>pii</th><th>rules (in / out)</th><th>chars</th>
    </tr></thead><tbody id="t-rows"></tbody></table>
    <div class="empty" id="t-empty">no traffic yet — send a request through the gateway</div>
  </section>
</main>
<script>
(function () {
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var api = function (path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  };

  // ---- tabs ----
  var tabs = document.querySelectorAll(".tab");
  Array.prototype.forEach.call(tabs, function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove("active"); });
      Array.prototype.forEach.call(document.querySelectorAll("section"), function (s) { s.classList.remove("active"); });
      t.classList.add("active");
      document.getElementById(t.getAttribute("data-tab")).classList.add("active");
    };
  });

  // ---- rules + allowlist ----
  var renderState = function (st) {
    var rr = document.getElementById("r-rows");
    rr.innerHTML = (st.rules || []).map(function (r) {
      var rm = r.source === "default"
        ? '<span style="color:#6c7086">—</span>'
        : '<button class="danger" data-rm="' + esc(r.name) + '">remove</button>';
      return "<tr>" +
        '<td><label class="sw"><input type="checkbox" data-rule="' + esc(r.name) + '"' +
          (r.enabled ? " checked" : "") + '/><span></span></label></td>' +
        "<td>" + esc(r.name) + (r.hasValidator ? ' <span class="pill rule">Luhn</span>' : "") + "</td>" +
        '<td><span class="pill src-' + esc(r.source) + '">' + esc(r.source) + "</span></td>" +
        "<td><code>" + esc(r.pattern) + "</code></td>" +
        "<td>" + esc(r.flags) + "</td>" +
        "<td>" + rm + "</td></tr>";
    }).join("");
    Array.prototype.forEach.call(rr.querySelectorAll("input[data-rule]"), function (cb) {
      cb.onchange = function () {
        api("/api/rules/toggle", { name: cb.getAttribute("data-rule"), enabled: cb.checked })
          .then(function (r) { renderState(r.j); });
      };
    });
    Array.prototype.forEach.call(rr.querySelectorAll("button[data-rm]"), function (b) {
      b.onclick = function () {
        api("/api/rules/remove", { name: b.getAttribute("data-rm") }).then(function (r) {
          if (!r.ok) document.getElementById("r-msg").textContent = r.j.error || "error";
          else renderState(r.j);
        });
      };
    });

    var ar = document.getElementById("a-rows");
    ar.innerHTML = (st.allowlist || []).length
      ? st.allowlist.map(function (a) {
          return "<tr>" +
            '<td><label class="sw"><input type="checkbox" data-allow="' + esc(a.id) + '"' +
              (a.enabled ? " checked" : "") + '/><span></span></label></td>' +
            "<td><code>" + esc(a.pattern) + "</code></td>" +
            "<td>" + esc(a.flags) + "</td>" +
            '<td><span class="pill src-' + esc(a.source) + '">' + esc(a.source) + "</span></td>" +
            '<td><button class="danger" data-arm="' + esc(a.id) + '">remove</button></td></tr>';
        }).join("")
      : '<tr><td colspan="5" class="empty">no allowlist entries</td></tr>';
    Array.prototype.forEach.call(ar.querySelectorAll("input[data-allow]"), function (cb) {
      cb.onchange = function () {
        api("/api/allowlist/toggle", { id: cb.getAttribute("data-allow"), enabled: cb.checked })
          .then(function (r) { renderState(r.j); });
      };
    });
    Array.prototype.forEach.call(ar.querySelectorAll("button[data-arm]"), function (b) {
      b.onclick = function () {
        api("/api/allowlist/remove", { id: b.getAttribute("data-arm") }).then(function (r) { renderState(r.j); });
      };
    });

    var mr = document.getElementById("m-rows");
    mr.innerHTML = (st.models || []).map(function (m) {
      return "<tr>" +
        '<td><label class="sw"><input type="checkbox" data-model="' + esc(m.id) + '"' +
          (m.blocked ? " checked" : "") + '/><span></span></label></td>' +
        "<td>" + esc(m.label) + (m.blocked ? ' <span class="pill pii-yes">blocked</span>' : "") + "</td>" +
        "<td><code>" + esc(m.match) + "</code></td></tr>";
    }).join("");
    Array.prototype.forEach.call(mr.querySelectorAll("input[data-model]"), function (cb) {
      cb.onchange = function () {
        api("/api/models/toggle", { id: cb.getAttribute("data-model"), blocked: cb.checked })
          .then(function (r) { renderState(r.j); });
      };
    });

    document.getElementById("hdr").innerHTML =
      "rules <b>" + (st.rules || []).filter(function (r) { return r.enabled; }).length +
      "/" + (st.rules || []).length + "</b> · allow <b>" + (st.allowlist || []).length +
      "</b> · blocked <b>" + (st.models || []).filter(function (m) { return m.blocked; }).length + "</b>";
  };

  document.getElementById("r-add").onclick = function () {
    document.getElementById("r-msg").textContent = "";
    api("/api/rules/add", {
      name: document.getElementById("r-name").value.trim(),
      pattern: document.getElementById("r-pat").value,
      flags: document.getElementById("r-flags").value.trim(),
    }).then(function (r) {
      if (!r.ok) { document.getElementById("r-msg").textContent = r.j.error || "error"; return; }
      document.getElementById("r-name").value = "";
      document.getElementById("r-pat").value = "";
      document.getElementById("r-flags").value = "";
      renderState(r.j);
    });
  };
  document.getElementById("a-add").onclick = function () {
    document.getElementById("a-msg").textContent = "";
    api("/api/allowlist/add", {
      pattern: document.getElementById("a-pat").value,
      flags: document.getElementById("a-flags").value.trim(),
    }).then(function (r) {
      if (!r.ok) { document.getElementById("a-msg").textContent = r.j.error || "error"; return; }
      document.getElementById("a-pat").value = "";
      document.getElementById("a-flags").value = "";
      renderState(r.j);
    });
  };

  // ---- traffic inspector ----
  var open = {};
  var rulesHtml = function (m) {
    var out = "";
    for (var k in m) out += '<span class="pill rule">' + esc(k) + " " + m[k] + "</span>";
    return out || '<span style="color:#6c7086">—</span>';
  };
  var statusClass = function (s) { return s >= 500 ? "err" : s >= 400 ? "warn" : "ok"; };
  var renderLogs = function () {
    var entries = window.__entries || [];
    var onlyPii = document.getElementById("onlyPii").checked;
    var view = onlyPii ? entries.filter(function (e) { return e.piiDetected; }) : entries;
    document.getElementById("t-empty").style.display = view.length ? "none" : "block";
    var rows = document.getElementById("t-rows");
    rows.innerHTML = view.map(function (e) {
      var t = new Date(e.timestamp).toLocaleTimeString();
      var prov = esc(e.provider) + (e.model ? "<br><span style='color:#6c7086'>" + esc(e.model) + "</span>" : "") +
        (e.blocked ? " <span class='pill pii-yes'>blocked</span>" : "");
      var main = '<tr class="row" data-id="' + esc(e.id) + '">' +
        "<td>" + esc(t) + "</td><td class='prov'>" + prov + "</td><td>" + esc(e.method) + "</td>" +
        "<td>" + esc(e.path) + "</td>" +
        "<td class='" + statusClass(e.status) + "'>" + esc(e.status) + "</td>" +
        "<td>" + (e.streaming ? "\\u25CF" : "\\u2014") + "</td>" +
        "<td><span class='pill " + (e.piiDetected ? "pii-yes" : "pii-no") + "'>" +
          (e.piiDetected ? "yes" : "no") + "</span></td>" +
        "<td>" + rulesHtml(e.matchedRules.inbound) + " / " + rulesHtml(e.matchedRules.outbound) + "</td>" +
        "<td>" + e.charCount.total + "</td></tr>";
      var clean = document.getElementById("clean").checked;
      var detail;
      if (clean && e.clean) {
        detail =
          "<div><h4>user prompt (Claude boilerplate stripped)</h4><pre>" + esc(e.clean.userPrompt || "(none)") + "</pre></div>" +
          "<div><h4>assistant output</h4><pre>" + esc(e.clean.assistantOutput || "(none)") + "</pre></div>";
      } else {
        detail =
          "<div><h4>request snapshot (redacted)</h4><pre>" + esc(e.payloadSnapshot.request || "(empty)") + "</pre></div>" +
          "<div><h4>response snapshot (redacted)</h4><pre>" + esc(e.payloadSnapshot.response || "(empty)") + "</pre></div>";
      }
      var d = open[e.id]
        ? "<tr class='detail'><td colspan='9'><div class='snap'>" + detail + "</div></td></tr>"
        : "";
      return main + d;
    }).join("");
    Array.prototype.forEach.call(rows.querySelectorAll("tr.row"), function (tr) {
      tr.onclick = function () { var id = tr.getAttribute("data-id"); open[id] = !open[id]; renderLogs(); };
    });
  };
  var loadLogs = function () {
    var clean = document.getElementById("clean").checked;
    fetch(clean ? "/logs?clean=1" : "/logs").then(function (r) { return r.json(); }).then(function (d) {
      window.__entries = d.entries || []; renderLogs();
    }).catch(function () {});
  };
  document.getElementById("t-refresh").onclick = loadLogs;
  document.getElementById("onlyPii").onchange = renderLogs;
  document.getElementById("clean").onchange = loadLogs;
  var timer = null;
  var setAuto = function () {
    if (timer) { clearInterval(timer); timer = null; }
    if (document.getElementById("auto").checked) timer = setInterval(loadLogs, 2000);
  };
  document.getElementById("auto").onchange = setAuto;

  // ---- boot ----
  api("/api/state").then(function (r) { renderState(r.j); });
  loadLogs(); setAuto();
})();
</script>
</body>
</html>`;
