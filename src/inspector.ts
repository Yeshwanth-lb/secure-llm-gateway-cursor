// ===== TRAFFIC INSPECTOR (frontend) =========================================
// A single self-contained HTML page (zero deps, no build step, no external
// assets) served at GET / and GET /inspector. It polls GET /logs and renders
// the ring buffer: provider, status, PII counts, and expandable post-redaction
// snapshots. Everything it shows is already redacted — the page adds no new
// data surface. Client script uses string concatenation (no template literals)
// so this outer template literal stays clean.

export const INSPECTOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Secure LLM Gateway — Traffic Inspector</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0b0e14; color: #cdd6f4; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center;
           gap: 16px; padding: 12px 18px; background: #11151f;
           border-bottom: 1px solid #1f2430; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; color: #89b4fa; }
  header .stat { color: #6c7086; }
  header .stat b { color: #cdd6f4; }
  header label { color: #a6adc8; user-select: none; }
  .spacer { flex: 1; }
  button { font: inherit; color: #cdd6f4; background: #1e2430; border: 1px solid #2a3040;
           border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { background: #262d3b; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #1a1f2b;
           white-space: nowrap; }
  th { position: sticky; top: 49px; background: #0f131c; color: #7f849c;
       font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: #121723; }
  td.path { max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .ok { color: #a6e3a1; } .warn { color: #f9e2af; } .err { color: #f38ba8; }
  .prov { color: #cba6f7; }
  .pii-yes { background: #f38ba822; color: #f38ba8; }
  .pii-no  { background: #6c708622; color: #6c7086; }
  .rule { background: #89b4fa22; color: #89b4fa; margin-right: 4px; }
  .detail td { background: #0a0d13; white-space: pre-wrap; }
  .snap { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .snap h4 { margin: 0 0 4px; color: #7f849c; font-weight: 500; }
  .snap pre { margin: 0; padding: 10px; background: #10141d; border: 1px solid #1c2230;
              border-radius: 6px; max-height: 260px; overflow: auto; white-space: pre-wrap;
              word-break: break-word; color: #bac2de; }
  .empty { padding: 40px; text-align: center; color: #6c7086; }
</style>
</head>
<body>
<header>
  <h1>Traffic Inspector</h1>
  <span class="stat">entries <b id="count">0</b></span>
  <span class="stat">pii <b id="piicount">0</b></span>
  <div class="spacer"></div>
  <label><input type="checkbox" id="onlyPii" /> only PII</label>
  <label><input type="checkbox" id="auto" checked /> auto-refresh 2s</label>
  <button id="refresh">refresh</button>
</header>
<table>
  <thead><tr>
    <th>time</th><th>provider</th><th>method</th><th>path</th><th>status</th>
    <th>stream</th><th>pii</th><th>rules (in / out)</th><th>chars</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<div class="empty" id="empty">no traffic yet — send a request through the gateway</div>
<script>
(function () {
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var statusClass = function (s) { return s >= 500 ? "err" : s >= 400 ? "warn" : "ok"; };
  var rulesHtml = function (m) {
    var out = "";
    for (var k in m) out += '<span class="pill rule">' + esc(k) + " " + m[k] + "</span>";
    return out || '<span style="color:#6c7086">—</span>';
  };
  var open = {};

  var render = function (entries) {
    var onlyPii = document.getElementById("onlyPii").checked;
    var rows = document.getElementById("rows");
    var view = onlyPii ? entries.filter(function (e) { return e.piiDetected; }) : entries;
    document.getElementById("count").textContent = entries.length;
    document.getElementById("piicount").textContent =
      entries.filter(function (e) { return e.piiDetected; }).length;
    document.getElementById("empty").style.display = view.length ? "none" : "block";
    rows.innerHTML = view.map(function (e) {
      var t = new Date(e.timestamp).toLocaleTimeString();
      var ins = rulesHtml(e.matchedRules.inbound);
      var outs = rulesHtml(e.matchedRules.outbound);
      var main =
        '<tr class="row" data-id="' + esc(e.id) + '">' +
        "<td>" + esc(t) + "</td>" +
        '<td class="prov">' + esc(e.provider) + "</td>" +
        "<td>" + esc(e.method) + "</td>" +
        '<td class="path" title="' + esc(e.path) + '">' + esc(e.path) + "</td>" +
        '<td class="' + statusClass(e.status) + '">' + esc(e.status) + "</td>" +
        "<td>" + (e.streaming ? "●" : "—") + "</td>" +
        '<td><span class="pill ' + (e.piiDetected ? "pii-yes" : "pii-no") + '">' +
          (e.piiDetected ? "yes" : "no") + "</span></td>" +
        "<td>" + ins + " / " + outs + "</td>" +
        "<td>" + e.charCount.total + "</td>" +
        "</tr>";
      var detail = "";
      if (open[e.id]) {
        detail =
          '<tr class="detail"><td colspan="9"><div class="snap">' +
          "<div><h4>request snapshot (redacted)</h4><pre>" +
            esc(e.payloadSnapshot.request || "(empty)") + "</pre></div>" +
          "<div><h4>response snapshot (redacted)</h4><pre>" +
            esc(e.payloadSnapshot.response || "(empty)") + "</pre></div>" +
          "</div></td></tr>";
      }
      return main + detail;
    }).join("");
    Array.prototype.forEach.call(rows.querySelectorAll("tr.row"), function (tr) {
      tr.onclick = function () {
        var id = tr.getAttribute("data-id");
        open[id] = !open[id];
        render(window.__entries || []);
      };
    });
  };

  var load = function () {
    fetch("/logs").then(function (r) { return r.json(); }).then(function (d) {
      window.__entries = d.entries || [];
      render(window.__entries);
    }).catch(function () {});
  };

  document.getElementById("refresh").onclick = load;
  document.getElementById("onlyPii").onchange = function () { render(window.__entries || []); };
  var timer = null;
  var setAuto = function () {
    if (timer) { clearInterval(timer); timer = null; }
    if (document.getElementById("auto").checked) timer = setInterval(load, 2000);
  };
  document.getElementById("auto").onchange = setAuto;
  load(); setAuto();
})();
</script>
</body>
</html>`;
