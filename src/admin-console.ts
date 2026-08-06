// ===== ADMIN DASHBOARD (Phase U) — served at GET /admin ======================
// Self-contained HTML page (login + Analytics / AI Controls / Audit tabs), same
// zero-asset, server-rendered pattern as console.ts. The embedded script uses
// string concatenation (NOT template literals) so nothing inside this outer
// template literal needs escaping — a stray backtick or ${ would break the page.
// All data comes from /admin/api/* behind a Bearer JWT held in sessionStorage.

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gateway Admin</title>
<style>
  :root {
    --bg:#0a0d13; --bg2:#0d1119; --panel:#141a26; --panel2:#171e2c;
    --line:#232b3d; --line2:#2e3852; --fg:#e8ebf2; --muted:#8892a6; --faint:#5c6579;
    --accent:#7aa2f7; --accent2:#9d7cf7; --ok:#9ece6a; --warn:#e0af68; --bad:#f7768e;
    --mono: ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5);
    --radius:12px;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body {
    margin:0; color:var(--fg); font:14px/1.55 var(--sans);
    background:
      radial-gradient(1200px 600px at 12% -10%, rgba(122,162,247,.08), transparent 60%),
      radial-gradient(1000px 500px at 100% 0%, rgba(157,124,247,.07), transparent 55%),
      var(--bg);
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  }
  a { color:var(--accent); text-decoration:none; }
  .mono, pre, code { font-family:var(--mono); }
  ::selection { background:rgba(122,162,247,.3); }
  /* thin scrollbars */
  *::-webkit-scrollbar { width:10px; height:10px; }
  *::-webkit-scrollbar-thumb { background:var(--line2); border-radius:8px; border:2px solid transparent; background-clip:padding-box; }
  *::-webkit-scrollbar-thumb:hover { background:#3a4560; }

  header {
    position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:8px;
    padding:12px 22px; border-bottom:1px solid var(--line);
    background:rgba(10,13,19,.75); backdrop-filter:saturate(140%) blur(10px);
  }
  header h1 {
    font-size:15px; margin:0 18px 0 0; font-weight:700; letter-spacing:.2px;
    display:flex; align-items:center; gap:9px; color:var(--fg);
  }
  header h1::before {
    content:""; width:12px; height:12px; border-radius:4px;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow:0 0 14px rgba(122,162,247,.6);
  }
  header .sp { flex:1; }
  #who { color:var(--muted); font-size:13px; }

  .tab {
    padding:7px 13px; border-radius:9px; cursor:pointer; color:var(--muted);
    background:transparent; border:1px solid transparent; font:inherit; font-size:13px; font-weight:500;
    transition:background .15s, color .15s, border-color .15s;
  }
  .tab:hover { color:var(--fg); background:rgba(255,255,255,.03); }
  .tab.active { color:var(--fg); border-color:var(--line2); background:linear-gradient(180deg,var(--panel2),var(--panel)); box-shadow:var(--shadow); }

  button {
    font:inherit; font-size:13px; color:var(--fg); background:var(--panel2);
    border:1px solid var(--line2); border-radius:9px; padding:7px 13px; cursor:pointer;
    transition:background .15s, border-color .15s, transform .05s;
  }
  button:hover { border-color:#3b4560; background:#1b2334; }
  button:active { transform:translateY(1px); }
  button.primary {
    background:linear-gradient(180deg,var(--accent),#5f8bf0); color:#0a0d13; border-color:transparent; font-weight:600;
    box-shadow:0 6px 18px -8px rgba(122,162,247,.8);
  }
  button.primary:hover { filter:brightness(1.06); }

  input,select,textarea {
    font:inherit; font-size:13px; color:var(--fg); background:var(--bg2);
    border:1px solid var(--line2); border-radius:9px; padding:8px 10px; outline:none;
    transition:border-color .15s, box-shadow .15s;
  }
  input:focus,select:focus,textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(122,162,247,.18); }
  input::placeholder,textarea::placeholder { color:var(--faint); }
  label { color:var(--muted); font-size:13px; display:inline-flex; align-items:center; gap:6px; }

  main { padding:22px 24px 60px; max-width:1500px; margin:0 auto; }

  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-bottom:22px; }
  .card {
    position:relative; overflow:hidden; background:linear-gradient(180deg,var(--panel2),var(--panel));
    border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; box-shadow:var(--shadow);
  }
  .card::before { content:""; position:absolute; inset:0 0 auto 0; height:3px; background:linear-gradient(90deg,var(--accent),var(--accent2)); opacity:.9; }
  .card .n { font-family:var(--mono); font-size:26px; font-weight:700; letter-spacing:-.5px; font-variant-numeric:tabular-nums; }
  .card .l { color:var(--muted); font-size:12px; margin-top:2px; }

  .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:18px; margin-bottom:20px; box-shadow:var(--shadow); }
  .panel h2 { font-size:11.5px; margin:0 0 14px; color:var(--muted); text-transform:uppercase; letter-spacing:.09em; font-weight:600; }

  table { width:100%; border-collapse:separate; border-spacing:0; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  thead th { position:sticky; top:60px; background:var(--panel); color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.06em; z-index:1; }
  tbody tr { transition:background .1s; }
  tbody tr:hover { background:rgba(255,255,255,.025); }
  td.mono, .pattern { font-family:var(--mono); }

  .row-controls { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
  .pill {
    display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:600;
    border:1px solid var(--line2); background:rgba(255,255,255,.03); color:var(--muted);
  }
  .pill.ok  { color:var(--ok);  border-color:rgba(158,206,106,.35); background:rgba(158,206,106,.1); }
  .pill.warn{ color:var(--warn);border-color:rgba(224,175,104,.35); background:rgba(224,175,104,.1); }
  .pill.bad { color:var(--bad); border-color:rgba(247,118,142,.35); background:rgba(247,118,142,.12); }
  .muted { color:var(--muted); }
  .hidden { display:none !important; }

  .login-wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:20px; }
  .login {
    background:linear-gradient(180deg,var(--panel2),var(--panel)); border:1px solid var(--line2);
    border-radius:16px; padding:32px 30px; width:340px; box-shadow:0 30px 80px -20px rgba(0,0,0,.7);
  }
  .login h1 { font-size:19px; margin:0 0 20px; display:flex; align-items:center; gap:10px; }
  .login h1::before { content:""; width:14px; height:14px; border-radius:5px; background:linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow:0 0 16px rgba(122,162,247,.7); }
  .login input { width:100%; margin-bottom:12px; padding:10px 12px; }
  .err { color:var(--bad); min-height:18px; font-size:12px; margin-top:8px; }

  .toggle { cursor:pointer; }
  input[type=checkbox] { width:15px; height:15px; accent-color:var(--accent); cursor:pointer; }

  .sctl { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:14px 4px; border-bottom:1px solid var(--line); }
  .sctl:last-child { border-bottom:none; }
  .sctl:hover { background:rgba(255,255,255,.015); }
  .sctl .name { min-width:240px; font-weight:600; }

  .chart svg { width:100%; height:190px; display:block; }
  .flex { display:flex; gap:20px; flex-wrap:wrap; }
  .flex > .panel { flex:1; min-width:320px; }
</style>
</head>
<body>

<div id="login" class="login-wrap">
  <form class="login" id="loginForm">
    <h1>Gateway Admin</h1>
    <input id="u" placeholder="username" autocomplete="username" />
    <input id="p" type="password" placeholder="password" autocomplete="current-password" />
    <button class="primary" type="submit" style="width:100%">Sign in</button>
    <div class="err" id="loginErr"></div>
  </form>
</div>

<div id="app" class="hidden">
  <header>
    <h1>Gateway Admin</h1>
    <button class="tab active" data-tab="analytics">Analytics</button>
    <button class="tab" data-tab="controls">AI Controls</button>
    <button class="tab" data-tab="rules">Rules</button>
    <button class="tab" data-tab="allowlist">Allowlist</button>
    <button class="tab" data-tab="models">Model Policy</button>
    <button class="tab" data-tab="guard">Prompt Guard</button>
    <button class="tab" data-tab="traffic">Traffic</button>
    <button class="tab" data-tab="try">Try Redaction</button>
    <button class="tab" data-tab="audit">Audit Log</button>
    <span class="sp"></span>
    <span class="muted" id="who"></span>
    <button id="logout">Log out</button>
  </header>
  <main>
    <section id="tab-analytics">
      <div class="row-controls">
        <label>Range
          <select id="range"><option value="today">Today</option><option value="7d" selected>7 days</option><option value="30d">30 days</option></select>
        </label>
        <label>Surface <select id="fSurface"><option value="">all</option></select></label>
        <label>Decision <select id="fDecision"><option value="">all</option><option>allowed</option><option>redacted</option><option>blocked</option></select></label>
        <button id="refresh">Refresh</button>
        <button id="csv">Export CSV</button>
      </div>
      <div class="cards" id="cards"></div>
      <div class="flex">
        <div class="panel chart"><h2>Event volume</h2><div id="series"></div></div>
        <div class="panel chart"><h2>PII types detected</h2><div id="pii"></div></div>
      </div>
      <div class="panel"><h2>Per-surface</h2><table id="surfaceTable"><thead><tr><th>Surface</th><th>Volume</th><th>Block rate</th><th>Redaction rate</th><th>Last seen</th><th>Health</th></tr></thead><tbody></tbody></table></div>
    </section>

    <section id="tab-controls" class="hidden">
      <div class="panel"><h2>Surfaces</h2><div id="surfaces"></div></div>
      <div class="panel"><h2>Global PII-type detection (applies to every surface)</h2><div id="piitypes" class="flex"></div></div>
    </section>

    <section id="tab-audit" class="hidden">
      <div class="row-controls">
        <label>Admin <input id="aAdmin" placeholder="username" /></label>
        <label>Action <input id="aAction" placeholder="action" /></label>
        <button id="aRefresh">Refresh</button>
      </div>
      <div class="panel"><table id="auditTable"><thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr></thead><tbody></tbody></table></div>
    </section>

    <section id="tab-rules" class="hidden">
      <div class="panel">
        <h2>Redaction rules — toggle to enable/disable on the live proxy instantly</h2>
        <div class="row-controls">
          <input id="rName" placeholder="RULE_NAME" />
          <input id="rPattern" placeholder="regex pattern" style="min-width:280px" />
          <input id="rFlags" placeholder="flags (g,i)" style="width:90px" />
          <button id="rAdd" class="primary">+ add custom rule</button>
        </div>
        <table id="rulesTable"><thead><tr><th>On</th><th>Name</th><th>Source</th><th>Pattern</th><th>Flags</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="tab-allowlist" class="hidden">
      <div class="panel">
        <h2>Allowlist — matches here are never redacted (survive as-is)</h2>
        <div class="row-controls">
          <input id="alPattern" placeholder="regex pattern" style="min-width:280px" />
          <input id="alFlags" placeholder="flags" style="width:90px" />
          <button id="alAdd" class="primary">+ add</button>
        </div>
        <table id="alTable"><thead><tr><th>On</th><th>Pattern</th><th>Flags</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="tab-models" class="hidden">
      <div class="panel">
        <h2>Model policy — a blocked model is rejected with 403 at the proxy (Claude Code / SDK)</h2>
        <table id="modelsTable"><thead><tr><th>Block</th><th>Model</th><th>Matches id contains</th></tr></thead><tbody></tbody></table>
      </div>
    </section>

    <section id="tab-guard" class="hidden">
      <div class="row-controls"><button id="gRefresh">Refresh</button><span class="muted">prompt-guard decisions — flagged prompt, guidance injected, and the model output it produced (admin-only, may contain raw prompt text)</span></div>
      <div class="cards" id="gCards"></div>
      <div class="panel"><table id="guardTable"><thead><tr><th>Time</th><th>Verdict</th><th>Categories</th><th>Conf</th><th>Surface</th><th>Prompt (click row for full detail + output)</th></tr></thead><tbody></tbody></table></div>
    </section>

    <section id="tab-traffic" class="hidden">
      <div class="row-controls"><button id="tRefresh">Refresh</button><span class="muted">last 100 requests (post-redaction snapshots only)</span></div>
      <div class="panel"><table id="trafficTable"><thead><tr><th>Time</th><th>Provider</th><th>Method</th><th>Source/Path</th><th>Status</th><th>PII</th><th>Rules (in/out)</th><th>Chars</th></tr></thead><tbody></tbody></table></div>
    </section>

    <section id="tab-try" class="hidden">
      <div class="panel">
        <h2>Try redaction — paste text, see what the engine would strip (nothing is stored)</h2>
        <textarea id="tryIn" style="width:100%;min-height:120px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px" placeholder="paste text with an email, SSN, card, api key..."></textarea>
        <div class="row-controls" style="margin-top:10px"><button id="tryRun" class="primary">Redact</button><span id="tryMatched" class="muted"></span></div>
        <pre id="tryOut" style="white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;margin-top:10px"></pre>
      </div>
    </section>
  </main>
</div>

<script>
(function(){
  "use strict";
  var KEY = "admin_jwt";
  var token = sessionStorage.getItem(KEY) || "";
  var el = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); };

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    if (opts.body && typeof opts.body !== "string"){ opts.body = JSON.stringify(opts.body); opts.headers["Content-Type"]="application/json"; }
    return fetch(path, opts).then(function(r){
      if (r.status === 401){ showLogin(); throw new Error("unauthorized"); }
      var ct = r.headers.get("content-type")||"";
      if (ct.indexOf("application/json")>=0) return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||("HTTP "+r.status)); return j; });
      return r.text();
    });
  }

  function showLogin(){ token=""; sessionStorage.removeItem(KEY); el("app").classList.add("hidden"); el("login").classList.remove("hidden"); }
  function showApp(){ el("login").classList.add("hidden"); el("app").classList.remove("hidden"); loadAll(); }

  el("loginForm").addEventListener("submit", function(e){
    e.preventDefault(); el("loginErr").textContent="";
    api("/admin/api/login", { method:"POST", body:{ username:el("u").value, password:el("p").value } })
      .then(function(j){ token=j.token; sessionStorage.setItem(KEY, token); el("who").textContent=j.username; showApp(); })
      .catch(function(err){ el("loginErr").textContent = err.message==="unauthorized" ? "invalid credentials" : err.message; });
  });
  el("logout").addEventListener("click", showLogin);

  // Tabs
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(b){
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(x){ x.classList.remove("active"); });
      b.classList.add("active");
      ["analytics","controls","rules","allowlist","models","guard","traffic","try","audit"].forEach(function(t){ el("tab-"+t).classList.toggle("hidden", t!==b.dataset.tab); });
      var t=b.dataset.tab;
      if (t==="controls") loadControls();
      if (t==="audit") loadAudit();
      if (t==="analytics") loadAnalytics();
      if (t==="rules"||t==="allowlist"||t==="models") loadConsole();
      if (t==="guard") loadGuard();
      if (t==="traffic") loadTraffic();
    });
  });

  ["refresh"].forEach(function(id){ el(id).addEventListener("click", loadAnalytics); });
  ["range","fSurface","fDecision"].forEach(function(id){ el(id).addEventListener("change", loadAnalytics); });
  el("csv").addEventListener("click", function(){
    var qs = analyticsQuery(); qs.set("format","csv");
    fetch("/admin/api/events?"+qs.toString(), { headers:{ "Authorization":"Bearer "+token } })
      .then(function(r){ return r.text(); })
      .then(function(t){ var a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([t],{type:"text/csv"})); a.download="events.csv"; a.click(); });
  });
  el("aRefresh").addEventListener("click", loadAudit);

  function analyticsQuery(){
    var q = new URLSearchParams();
    q.set("range", el("range").value);
    if (el("fSurface").value) q.set("surface", el("fSurface").value);
    if (el("fDecision").value) q.set("decision", el("fDecision").value);
    return q;
  }

  function ago(ts){ if(!ts) return "never"; var s=Math.floor((Date.now()-ts)/1000); if(s<60)return s+"s ago"; if(s<3600)return Math.floor(s/60)+"m ago"; if(s<86400)return Math.floor(s/3600)+"h ago"; return Math.floor(s/86400)+"d ago"; }
  function rate(part,total){ return total? Math.round(100*part/total)+"%":"0%"; }

  function loadAll(){ loadAnalytics(); }

  function loadAnalytics(){
    api("/admin/api/analytics?"+analyticsQuery().toString()).then(function(j){
      var a=j.analytics;
      // surface filter options
      var sel=el("fSurface"); if(sel.options.length<=1){ (j.surfaces||[]).forEach(function(s){ var o=document.createElement("option"); o.value=s.surface; o.textContent=s.surface; sel.appendChild(o); }); }
      var c=a.cards;
      el("cards").innerHTML =
        card(c.today,"events today")+card(c.d7,"events 7d")+card(c.d30,"events 30d")+
        card(c.redactions,"redactions")+card(c.blocks,"blocks")+card(c.activeSurfaces,"active surfaces");
      drawSeries(a.series);
      drawPii(a.piiBreakdown);
      var tb=el("surfaceTable").querySelector("tbody"); tb.innerHTML="";
      if(!a.perSurface.length){ tb.innerHTML='<tr><td colspan="6" class="muted">no data yet</td></tr>'; }
      a.perSurface.forEach(function(s){
        var stale = a.now - s.lastSeen > 3600000;
        var health = s.volume===0 ? '<span class="pill">no data</span>' : (stale ? '<span class="pill warn">stale</span>' : '<span class="pill ok">active</span>');
        tb.innerHTML += "<tr><td>"+esc(s.surface)+"</td><td>"+s.volume+"</td><td>"+rate(s.blocks,s.volume)+"</td><td>"+rate(s.redactions,s.volume)+"</td><td class='muted'>"+ago(s.lastSeen)+"</td><td>"+health+"</td></tr>";
      });
    }).catch(function(){});
  }
  function card(n,l){ return '<div class="card"><div class="n">'+n+'</div><div class="l">'+esc(l)+'</div></div>'; }

  function drawSeries(series){
    // group by bucket, stack decisions
    var buckets={}; series.forEach(function(r){ (buckets[r.bucket]=buckets[r.bucket]||{})[r.decision]=r.n; });
    var keys=Object.keys(buckets).sort(function(a,b){return a-b;});
    if(!keys.length){ el("series").innerHTML='<div class="muted">no data</div>'; return; }
    var max=1; keys.forEach(function(k){ var t=(buckets[k].allowed||0)+(buckets[k].redacted||0)+(buckets[k].blocked||0); if(t>max)max=t; });
    var W=Math.max(keys.length*26,300), H=160, bw=W/keys.length*0.7, colors={allowed:"#565f89",redacted:"#7aa2f7",blocked:"#f7768e"};
    var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
    keys.forEach(function(k,i){ var b=buckets[k], x=i*(W/keys.length)+ (W/keys.length-bw)/2, y=H; ["allowed","redacted","blocked"].forEach(function(d){ var v=b[d]||0; if(!v)return; var h=(v/max)*(H-20); y-=h; svg+='<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="'+colors[d]+'"><title>'+d+": "+v+'</title></rect>'; }); });
    svg+='</svg><div class="muted" style="font-size:11px">'+new Date(keys[0]*1).toLocaleString()+" \\u2192 "+new Date(keys[keys.length-1]*1).toLocaleString()+' &nbsp; <span style="color:#565f89">allowed</span> <span style="color:#7aa2f7">redacted</span> <span style="color:#f7768e">blocked</span></div>';
    el("series").innerHTML=svg;
  }

  function drawPii(breakdown){
    if(!breakdown.length){ el("pii").innerHTML='<div class="muted">no PII detected in range</div>'; return; }
    var max=breakdown[0].n||1, rows=breakdown.slice(0,14);
    var h="";
    rows.forEach(function(r){ var w=Math.round(100*r.n/max); h+='<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:120px;color:#8b93a7;font-size:12px">'+esc(r.type)+'</span><span style="height:12px;width:'+w+'%;min-width:2px;background:#7aa2f7;border-radius:3px"></span><span style="font-size:12px">'+r.n+'</span></div>'; });
    el("pii").innerHTML=h;
  }

  function loadControls(){
    Promise.all([ api("/admin/api/surfaces"), api("/admin/api/pii-types") ]).then(function(res){
      var data=res[0], pii=res[1];
      var catalog={}; (data.catalog||[]).forEach(function(c){ catalog[c.surface]=c; });
      var host=el("surfaces"); host.innerHTML="";
      data.surfaces.forEach(function(s){
        var modes=(catalog[s.surface]||{modes:["redact","block","off"]}).modes;
        var label=(catalog[s.surface]||{}).label||s.surface;
        var opts=modes.map(function(m){ return '<option value="'+m+'"'+(m===s.mode?" selected":"")+'>'+m+'</option>'; }).join("");
        var div=document.createElement("div"); div.className="sctl";
        div.innerHTML='<span class="name">'+esc(label)+'</span>'+
          '<label>enabled <input type="checkbox" class="en" '+(s.enabled?"checked":"")+'></label>'+
          '<label>mode <select class="mode">'+opts+'</select></label>'+
          '<label>on error <select class="fm"><option value="closed"'+(s.fail_mode==="closed"?" selected":"")+'>fail-closed</option><option value="open"'+(s.fail_mode==="open"?" selected":"")+'>fail-open</option></select></label>'+
          '<span class="muted" style="font-size:11px">by '+esc(s.updated_by)+'</span>';
        var save=function(patch){ api("/admin/api/surfaces/"+encodeURIComponent(s.surface),{method:"PUT",body:patch}).then(function(){ /* ok */ }).catch(function(e){ alert(e.message); loadControls(); }); };
        div.querySelector(".en").addEventListener("change", function(e){
          if(!e.target.checked && !confirm("Disable "+label+"? Its enforcement point will stop redacting/blocking.")){ e.target.checked=true; return; }
          save({enabled:e.target.checked});
        });
        div.querySelector(".mode").addEventListener("change", function(e){ save({mode:e.target.value}); });
        div.querySelector(".fm").addEventListener("change", function(e){ save({fail_mode:e.target.value}); });
        host.appendChild(div);
      });
      var ph=el("piitypes"); ph.innerHTML="";
      var col=document.createElement("div"); col.className="panel"; col.style.flex="1";
      (pii.types||[]).forEach(function(t){
        var l=document.createElement("label"); l.style.display="block"; l.style.padding="3px 0";
        l.innerHTML='<input type="checkbox" '+(t.enabled?"checked":"")+'> '+esc(t.name);
        l.querySelector("input").addEventListener("change", function(e){ api("/admin/api/pii-types/"+encodeURIComponent(t.name),{method:"PUT",body:{enabled:e.target.checked}}).catch(function(err){ alert(err.message); }); });
        col.appendChild(l);
      });
      ph.appendChild(col);
    }).catch(function(){});
  }

  function loadAudit(){
    var q=new URLSearchParams(); if(el("aAdmin").value)q.set("admin",el("aAdmin").value); if(el("aAction").value)q.set("action",el("aAction").value);
    api("/admin/api/audit?"+q.toString()).then(function(j){
      var tb=el("auditTable").querySelector("tbody"); tb.innerHTML="";
      if(!j.audit.length){ tb.innerHTML='<tr><td colspan="6" class="muted">no audit entries</td></tr>'; return; }
      j.audit.forEach(function(a){
        var cell=function(v){ return "<td class='muted' title='"+esc(v||"")+"' style='max-width:360px;white-space:pre-wrap;word-break:break-all;font-size:11px'>"+esc(v||"")+"</td>"; };
        tb.innerHTML += "<tr><td class='muted'>"+esc(new Date(a.timestamp).toLocaleString())+"</td><td>"+esc(a.admin_username)+"</td><td>"+esc(a.action)+"</td><td>"+esc(a.target||"")+"</td>"+cell(a.before_value)+cell(a.after_value)+"</tr>";
      });
    }).catch(function(){});
  }

  // --- Rules / Allowlist / Model Policy (mirrors of the Gateway Console) ------
  function consoleAction(sub, body){ return api("/admin/api/console"+sub, { method:"POST", body:body }); }

  function loadConsole(){
    api("/admin/api/console").then(function(s){
      // rules
      var rb=el("rulesTable").querySelector("tbody"); rb.innerHTML="";
      (s.rules||[]).forEach(function(r){
        var tr=document.createElement("tr");
        tr.innerHTML="<td><input type='checkbox' "+(r.enabled?"checked":"")+"></td><td>"+esc(r.name)+"</td><td class='muted'>"+esc(r.source||"")+"</td><td class='muted' style='max-width:520px;word-break:break-all;font-size:11px'>"+esc(r.pattern||"")+"</td><td class='muted'>"+esc(r.flags||"")+"</td><td>"+(r.source==="custom"?"<button class='rm'>remove</button>":"")+"</td>";
        tr.querySelector("input").addEventListener("change", function(e){ consoleAction("/rules/toggle",{name:r.name,enabled:e.target.checked}).catch(function(x){alert(x.message);loadConsole();}); });
        var rm=tr.querySelector(".rm"); if(rm) rm.addEventListener("click", function(){ consoleAction("/rules/remove",{name:r.name}).then(loadConsole).catch(function(x){alert(x.message);}); });
        rb.appendChild(tr);
      });
      // allowlist
      var ab=el("alTable").querySelector("tbody"); ab.innerHTML="";
      (s.allowlist||[]).forEach(function(a){
        var tr=document.createElement("tr");
        tr.innerHTML="<td><input type='checkbox' "+(a.enabled?"checked":"")+"></td><td class='muted' style='word-break:break-all'>"+esc(a.pattern||"")+"</td><td class='muted'>"+esc(a.flags||"")+"</td><td><button class='rm'>remove</button></td>";
        tr.querySelector("input").addEventListener("change", function(e){ consoleAction("/allowlist/toggle",{id:a.id,enabled:e.target.checked}).catch(function(x){alert(x.message);loadConsole();}); });
        tr.querySelector(".rm").addEventListener("click", function(){ consoleAction("/allowlist/remove",{id:a.id}).then(loadConsole).catch(function(x){alert(x.message);}); });
        ab.appendChild(tr);
      });
      // models
      var mb=el("modelsTable").querySelector("tbody"); mb.innerHTML="";
      (s.models||[]).forEach(function(m){
        var tr=document.createElement("tr");
        tr.innerHTML="<td><input type='checkbox' "+(m.blocked?"checked":"")+"></td><td>"+esc(m.label||m.id)+"</td><td class='muted'>"+esc(m.match||m.id)+"</td>";
        tr.querySelector("input").addEventListener("change", function(e){ consoleAction("/models/toggle",{id:m.id,blocked:e.target.checked}).catch(function(x){alert(x.message);loadConsole();}); });
        mb.appendChild(tr);
      });
    }).catch(function(){});
  }
  el("rAdd").addEventListener("click", function(){
    if(!el("rName").value||!el("rPattern").value) return alert("name and pattern required");
    consoleAction("/rules/add",{name:el("rName").value,pattern:el("rPattern").value,flags:el("rFlags").value||undefined})
      .then(function(){ el("rName").value="";el("rPattern").value="";el("rFlags").value=""; loadConsole(); }).catch(function(x){alert(x.message);});
  });
  el("alAdd").addEventListener("click", function(){
    if(!el("alPattern").value) return alert("pattern required");
    consoleAction("/allowlist/add",{pattern:el("alPattern").value,flags:el("alFlags").value||undefined})
      .then(function(){ el("alPattern").value="";el("alFlags").value=""; loadConsole(); }).catch(function(x){alert(x.message);});
  });

  // --- Traffic Inspector (click a row to expand its redacted snapshot) -------
  var trafficExpanded = {}; // entry id -> expanded, preserved across auto-refresh
  function loadTraffic(){
    api("/admin/api/logs?clean=1").then(function(j){
      var tb=el("trafficTable").querySelector("tbody"); tb.innerHTML="";
      if(!j.entries.length){ tb.innerHTML='<tr><td colspan="8" class="muted">no traffic yet</td></tr>'; return; }
      j.entries.forEach(function(e){
        var prov=e.provider; var src=String(e.path||"");
        if(e.method==="HOOK"||src.indexOf("cursor")===0) prov="cursor";
        else { var mm=src.match(/^([a-z0-9]+)-web-extension$/); if(mm) prov=mm[1]; }
        var rin=Object.keys(e.matchedRules.inbound||{}).map(function(k){return k+" "+e.matchedRules.inbound[k];}).join(", ");
        var rout=Object.keys(e.matchedRules.outbound||{}).map(function(k){return k+" "+e.matchedRules.outbound[k];}).join(", ");
        var main=document.createElement("tr"); main.style.cursor="pointer";
        main.innerHTML="<td class='muted'>"+esc(new Date(e.timestamp).toLocaleTimeString())+"</td><td>"+esc(prov)+(e.model?"<br><span class='muted' style='font-size:11px'>"+esc(e.model)+"</span>":"")+"</td><td>"+esc(e.method)+"</td><td class='muted' style='max-width:220px;word-break:break-all'>"+esc(e.path)+"</td><td>"+esc(e.status)+"</td><td><span class='pill "+(e.piiDetected?"bad":"")+"'>"+(e.piiDetected?"yes":"no")+"</span></td><td class='muted' style='font-size:11px'>"+esc(rin)+" / "+esc(rout)+"</td><td>"+(e.charCount?e.charCount.total:0)+"</td>";
        var det=document.createElement("tr"); if(!trafficExpanded[e.id]) det.classList.add("hidden");
        var req=(e.clean&&e.clean.userPrompt)||(e.payloadSnapshot&&e.payloadSnapshot.request)||"";
        var resp=(e.clean&&e.clean.assistantOutput)||(e.payloadSnapshot&&e.payloadSnapshot.response)||"";
        det.innerHTML="<td colspan='8' style='background:var(--bg)'><div class='flex'><div style='flex:1;min-width:280px'><div class='muted' style='font-size:11px;margin-bottom:4px'>request snapshot (redacted)</div><pre style='white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;margin:0;max-height:280px;overflow:auto'>"+(esc(req)||"<span class='muted'>(none)</span>")+"</pre></div><div style='flex:1;min-width:280px'><div class='muted' style='font-size:11px;margin-bottom:4px'>response snapshot (redacted)</div><pre style='white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;margin:0;max-height:280px;overflow:auto'>"+(esc(resp)||"<span class='muted'>(none)</span>")+"</pre></div></div></td>";
        main.addEventListener("click", function(){ det.classList.toggle("hidden"); trafficExpanded[e.id] = !det.classList.contains("hidden"); });
        tb.appendChild(main); tb.appendChild(det);
      });
    }).catch(function(){});
  }
  el("tRefresh").addEventListener("click", loadTraffic);
  // Auto-refresh the Traffic tab every 2s while it is visible + logged in, matching
  // the loopback console. Preserves expanded rows via trafficExpanded.
  setInterval(function(){
    if (el("app").classList.contains("hidden")) return;
    if (!el("tab-traffic").classList.contains("hidden")) loadTraffic();
  }, 2000);

  // --- Prompt Guard (Checkpoint 1) — click a row to see prompt/guidance/output
  var guardExpanded = {};
  function loadGuard(){
    api("/admin/api/prompt-guard").then(function(j){
      var s=j.summary||{byCategory:{}};
      var cats=Object.keys(s.byCategory||{}).sort(function(a,b){return s.byCategory[b]-s.byCategory[a];});
      el("gCards").innerHTML = card(s.total||0,"flagged prompts") + card(s.injected||0,"guidance injected") +
        cats.slice(0,4).map(function(c){ return card(s.byCategory[c],c); }).join("");
      var tb=el("guardTable").querySelector("tbody"); tb.innerHTML="";
      if(!j.entries.length){ tb.innerHTML='<tr><td colspan="6" class="muted">no prompt-guard activity yet — flagged prompts appear here</td></tr>'; return; }
      j.entries.forEach(function(e){
        var vpill = e.verdict==="block" ? "bad" : (e.verdict==="inject" ? "warn" : "");
        var main=document.createElement("tr"); main.style.cursor="pointer";
        main.innerHTML="<td class='muted'>"+esc(new Date(e.timestamp).toLocaleTimeString())+"</td>"+
          "<td><span class='pill "+vpill+"'>"+esc(e.verdict)+"</span></td>"+
          "<td class='muted' style='font-size:11px'>"+esc((e.categories||[]).join(", "))+"</td>"+
          "<td class='muted'>"+(e.confidence!=null?Math.round(e.confidence*100)+"%":"")+"</td>"+
          "<td class='muted' style='font-size:11px'>"+esc(e.surface||"")+"</td>"+
          "<td class='muted' style='max-width:460px;word-break:break-word'>"+esc(String(e.rawPrompt||"").slice(0,160))+"</td>";
        var det=document.createElement("tr"); if(!guardExpanded[e.id]) det.classList.add("hidden");
        var pane=function(title,body){ return "<div style='flex:1;min-width:260px'><div class='muted' style='font-size:11px;margin-bottom:4px'>"+title+"</div><pre style='white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;margin:0;max-height:340px;overflow:auto'>"+(esc(body)||"<span class='muted'>(none)</span>")+"</pre></div>"; };
        det.innerHTML="<td colspan='6' style='background:var(--bg)'><div class='flex'>"+
          pane("prompt (raw)",e.rawPrompt)+pane("guidance injected",e.guidance)+pane("model output (what it generated)",e.response||"")+"</div></td>";
        main.addEventListener("click", function(){ det.classList.toggle("hidden"); guardExpanded[e.id]=!det.classList.contains("hidden"); });
        tb.appendChild(main); tb.appendChild(det);
      });
    }).catch(function(){});
  }
  el("gRefresh").addEventListener("click", loadGuard);
  // Auto-refresh the Prompt Guard tab while visible + logged in (like Traffic).
  setInterval(function(){
    if (el("app").classList.contains("hidden")) return;
    if (!el("tab-guard").classList.contains("hidden")) loadGuard();
  }, 3000);

  // --- Try Redaction ---------------------------------------------------------
  el("tryRun").addEventListener("click", function(){
    api("/admin/api/try", { method:"POST", body:{ text: el("tryIn").value } }).then(function(j){
      el("tryOut").textContent = j.redacted;
      var keys=Object.keys(j.matched||{});
      el("tryMatched").textContent = keys.length ? ("matched: "+keys.map(function(k){return k+" ("+j.matched[k]+")";}).join(", ")) : "no PII detected";
    }).catch(function(x){ el("tryOut").textContent="error: "+x.message; });
  });

  // boot
  if (token) { api("/admin/api/me").then(function(m){ el("who").textContent=m.username; showApp(); }).catch(showLogin); }
  else showLogin();
})();
</script>
</body>
</html>`;
