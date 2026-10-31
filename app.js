// Pinned: this page holds your API key, so never auto-pull a new SDK release.
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@1.3.0";

// ---------- config ----------

const MCP_NAME = "rea";
// Always-loaded REA tools (the routing entry points from REA's own skill).
// The other ~220 tools (~70k tokens of schemas) are deferred and found via tool search.
const CORE_TOOLS = [
  "binary_session", "open_binary", "inspect_artifact", "analyze_javascript_application",
  "inspect_android_package", "inspect_managed_artifact", "close_binary",
];
const MODELS_WITH_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const MAX_ROUNDS = 12; // pause_turn resumptions per question

const PRESETS = [
  { label: "Map it", q: "Give me a map of this target: what it is, how it's built, main components, notable libraries, and where the interesting logic lives. Evidence for each claim." },
  { label: "How does X work?", q: "How does [FEATURE] work in this target? Trace it to the code and show the evidence." },
  { label: "Endpoints & secrets", q: "List the network endpoints, hosts, API keys/tokens, and auth flow this target uses. Separate observed from inferred." },
  { label: "Security review", q: "Do a quick security review: risky permissions, exported components, hardcoded secrets, weak crypto, insecure network config. Rank by severity with evidence." },
  { label: "Rebuild it", q: "Explain how [FEATURE] works with evidence, then write a clean-room implementation plan and starter code for my own project." },
];

const SYSTEM_BASE = `You are REA on a phone. The user is investigating software through the REA (Reverse Engineer Anything) MCP server, which runs on their own Linux host (Ghidra, JADX, and REA's static analyzers are installed; there is no GUI, no Hopper/IDA, no browser, and no Android device).

How to work:
- Follow the REA workflow below: route the target first, prefer the tool that directly answers the question, and keep Evidence IDs.
- Most REA tools are deferred. Use the tool search tool to find the right REA tool by name or capability before calling it. Core entry points (open_binary, inspect_artifact, analyze_javascript_application, inspect_android_package, inspect_managed_artifact, binary_session, close_binary) are always available.
- REA results can be very large. Pass \`detail: "summary"\` wherever a tool accepts it, and page retained views instead of requesting complete inventories.
- Target paths are absolute paths on the host. Only use paths the user gave you or that REA returned.
- The user reads on a phone: lead with the answer, then the evidence. Use short sections, bullets, and small code blocks. Cite evidence as \`ev_…\` IDs or file/function/address. Mark inferences as "(inferred)" and state limitations plainly.
- Only analyze targets the user supplied. Don't run or instrument a target unless the user asks for runtime work.

=== REA workflow skill (from github.com/morluto/rea, MIT) ===
`;

// ---------- storage ----------

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

let settings = store.get("rea.settings", { hostUrl: "", hostToken: "", apiKey: "", model: "claude-opus-5-5", effort: "high" });
let target = store.get("rea.target", null); // {name, path}
let messages = []; // full API transcript for the current investigation (append-only)
let running = null; // {stream, aborted}
let skillText = "";

// One-tap setup link printed by host/setup.sh: #host=...&token=...
(function readConnectLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("host") && h.get("token")) {
    settings.hostUrl = h.get("host").replace(/\/+$/, "");
    settings.hostToken = h.get("token");
    store.set("rea.settings", settings);
    history.replaceState(null, "", location.pathname + location.search);
  }
})();

// ---------- tabs ----------

function show(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "targets") loadFiles();
  if (view === "history") renderHistory();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

// ---------- host API ----------

const hostReady = () => settings.hostUrl && settings.hostToken;

async function hostFetch(path, opts = {}) {
  const res = await fetch(settings.hostUrl + path, {
    ...opts,
    headers: { Authorization: `Bearer ${settings.hostToken}`, ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Host returned ${res.status}`);
  return body;
}

async function pingHost() {
  const dot = $("#host-dot");
  if (!hostReady()) { dot.className = "dot"; return false; }
  try {
    const r = await fetch(settings.hostUrl + "/health").then((x) => x.json());
    dot.className = "dot " + (r.rea ? "ok" : "warn");
    dot.title = r.rea ? "Host online" : "Host up, REA starting";
    return r.rea;
  } catch {
    dot.className = "dot bad"; dot.title = "Host unreachable";
    return false;
  }
}

// ---------- targets ----------

function renderTarget() {
  $("#target-pick").textContent = target ? `🎯 ${target.name}` : "None. Tap to pick or upload.";
}
$("#target-pick").onclick = () => show("targets");

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function selectTarget(t) {
  target = t;
  store.set("rea.target", target);
  renderTarget();
  resetThread();
}

async function loadFiles() {
  const ul = $("#files");
  if (!hostReady()) { ul.innerHTML = `<li class="empty">Set your host in Settings first.</li>`; return; }
  ul.innerHTML = `<li class="empty"><span class="spinner"></span>Loading…</li>`;
  try {
    const { files } = await hostFetch("/files");
    if (!files.length) { ul.innerHTML = `<li class="empty">No targets yet. Upload one.</li>`; return; }
    ul.innerHTML = "";
    for (const f of files) {
      const li = document.createElement("li");
      const selected = target?.path === f.path;
      li.className = selected ? "selected" : "";
      li.innerHTML = `<b>${esc(f.name)}</b>
        <div class="meta">${f.dir ? "folder" : fmtBytes(f.bytes)} · ${new Date(f.modified).toLocaleString()}</div>
        <div class="row"><button class="btn small" data-a="use">${selected ? "Selected" : "Investigate"}</button><button class="btn small ghost" data-a="del">Delete</button></div>`;
      li.querySelector('[data-a="use"]').onclick = () => {
        if (running) return;
        if (target?.path !== f.path) selectTarget({ name: f.name, path: f.path });
        show("investigate");
      };
      li.querySelector('[data-a="del"]').onclick = async () => {
        if (running) { alert("Wait for the current investigation to finish."); return; }
        if (!confirm(`Delete ${f.name} from the host?`)) return;
        await hostFetch(`/files/${encodeURIComponent(f.name)}`, { method: "DELETE" }).catch((e) => alert(e.message));
        if (target?.path === f.path) { target = null; store.set("rea.target", null); renderTarget(); }
        loadFiles();
      };
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="empty err">${esc(e.message)}</li>`;
  }
}

$("#upload").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#targets-status");
  if (!hostReady()) { status.textContent = "Set your host in Settings first."; return; }
  if (running) { status.textContent = "Wait for the current investigation to finish."; return; }
  const bar = $("#upload-progress");
  bar.hidden = false;
  bar.firstElementChild.style.width = "0%";
  status.className = "status";
  status.textContent = `Uploading ${file.name}…`;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${settings.hostUrl}/upload${$("#extract").checked ? "?extract=1" : ""}`);
  xhr.setRequestHeader("Authorization", `Bearer ${settings.hostToken}`);
  xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`;
  };
  xhr.onload = () => {
    bar.hidden = true;
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status >= 300) { status.className = "status err"; status.textContent = body.error || `Upload failed (${xhr.status})`; return; }
    status.textContent = `Uploaded ${body.name}${body.extracted ? " (unzipped)" : ""}. Selected as target.`;
    selectTarget({ name: body.name, path: body.path });
    loadFiles();
  };
  xhr.onerror = () => { bar.hidden = true; status.className = "status err"; status.textContent = "Upload failed: host unreachable."; };
  xhr.send(file);
});

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Small, safe markdown: escape first, then format.
function md(src) {
  const blocks = [];
  let s = String(src ?? "").replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  const inline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of s.split("\n")) {
    let m;
    if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim()))) { closeList(); out.push(blocks[+m[1]]); }
    else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { closeList(); const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${inline(m[2])}</h${n}>`); }
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

function resultText(block) {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x.text ?? (x.tool_name ? `→ ${x.tool_name}` : "")).join("\n");
  if (c && typeof c === "object") {
    if (Array.isArray(c.tool_references)) return c.tool_references.map((r) => `→ ${r.tool_name}`).join("\n");
    return JSON.stringify(c);
  }
  return "";
}

function toolCard(use, result) {
  const isSearch = use.type === "server_tool_use";
  const name = isSearch ? `tool search: ${use.input?.query ?? ""}` : use.name;
  const err = result?.is_error || (result?.content?.type ?? "").endsWith("_error");
  const state = !result ? "running" : err ? "error" : "done";
  const text = result ? resultText(result) : "";
  const preview = text.length > 4000 ? `${text.slice(0, 4000)}\n… (${fmtBytes(text.length)} total)` : text;
  const evid = (text.match(/ev_[0-9a-f]{12,}/) || [])[0];
  return `<details class="tool ${state}">
    <summary><span class="tdot"></span><b>${esc(name)}</b>${evid ? `<span class="ev">${esc(evid.slice(0, 15))}…</span>` : ""}<span class="tsize">${result ? fmtBytes(text.length) : "…"}</span></summary>
    <div class="tbody"><div class="tlabel">input</div><pre>${esc(JSON.stringify(use.input ?? {}, null, 2))}</pre>
    ${result ? `<div class="tlabel">result</div><pre>${esc(preview)}</pre>` : ""}</div>
  </details>`;
}

// Render one assistant turn (possibly several pause_turn rounds) from its content blocks.
function renderAssistant(el, blocks, liveText = "") {
  const results = new Map();
  for (const b of blocks) if (b.tool_use_id) results.set(b.tool_use_id, b);
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text?.trim()) parts.push(`<div class="md">${md(b.text)}</div>`);
    else if (b.type === "mcp_tool_use" || b.type === "server_tool_use") parts.push(toolCard(b, results.get(b.id)));
  }
  if (liveText) parts.push(`<div class="md">${md(liveText)}</div>`);
  el.innerHTML = parts.join("") || `<p class="muted"><span class="spinner"></span>Working…</p>`;
}

function addBubble(cls, html) {
  const d = document.createElement("div");
  d.className = `bubble ${cls}`;
  d.innerHTML = html;
  $("#thread").appendChild(d);
  d.scrollIntoView({ block: "end", behavior: "smooth" });
  return d;
}

function resetThread() {
  messages = [];
  $("#thread").innerHTML = "";
  $("#send").textContent = "Investigate";
  setStatus("");
}
$("#new").onclick = () => { if (!running) resetThread(); };

function setStatus(msg, err = false, spin = false) {
  const s = $("#status");
  s.className = "status" + (err ? " err" : "");
  s.innerHTML = (spin ? '<span class="spinner"></span>' : "") + esc(msg);
}

function renderPresets() {
  const box = $("#presets");
  box.innerHTML = "";
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = p.label;
    b.onclick = () => {
      const q = $("#question");
      q.value = p.q;
      q.focus();
      const i = p.q.indexOf("[");
      if (i >= 0) q.setSelectionRange(i, p.q.indexOf("]") + 1);
    };
    box.appendChild(b);
  }
}

// ---------- Claude + REA ----------

async function loadSkill() {
  if (!skillText) skillText = await fetch("vendor/rea-skill.md").then((r) => (r.ok ? r.text() : "")).catch(() => "");
  return skillText;
}

function buildRequest() {
  const model = settings.model;
  const useSearch = model !== "claude-haiku-5-5"; // Haiku is cheap enough to load the full catalog
  const toolset = { type: "mcp_toolset", mcp_server_name: MCP_NAME };
  const tools = [];
  if (useSearch) {
    tools.push({ type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" });
    toolset.default_config = { defer_loading: true };
    toolset.configs = Object.fromEntries(CORE_TOOLS.map((n) => [n, { defer_loading: false }]));
  }
  tools.push(toolset);

  const params = {
    model,
    max_tokens: 64000,
    system: [
      { type: "text", text: SYSTEM_BASE + skillText, cache_control: { type: "ephemeral" } },
      { type: "text", text: target ? `Current target on the host: ${target.path}` : "No target selected yet; ask the user to upload one if needed." },
    ],
    output_config: { effort: settings.effort },
    mcp_servers: [{ type: "url", url: `${settings.hostUrl}/mcp`, name: MCP_NAME, authorization_token: settings.hostToken }],
    tools,
    messages,
    betas: ["mcp-client-2026-09-15"],
  };
  if (MODELS_WITH_FALLBACK.has(model)) {
    params.fallbacks = "default";
    params.betas.push("server-side-fallback-2026-07-01");
  }
  return params;
}

async function ask(question) {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 30 * 60 * 1000 });
  await loadSkill();
  messages.push({ role: "user", content: [{ type: "text", text: question }] });
  addBubble("user", md(question));
  const el = addBubble("assistant", "");
  const done = []; // authoritative blocks from finished rounds of this turn
  const started = Date.now();
  let calls = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const live = [];
    let liveText = "";
    const stream = client.beta.messages.stream(buildRequest());
    running = { stream, aborted: false };
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      setStatus(`${calls ? `${calls} tool call${calls > 1 ? "s" : ""} · ` : ""}${s}s`, false, true);
    }, 500);
    stream.on("streamEvent", (ev) => {
      if (ev.type !== "content_block_start") return;
      const b = ev.content_block;
      if (b.type === "mcp_tool_use" || b.type === "server_tool_use") { calls++; live.push({ ...b, input: b.input ?? {} }); }
      else if (b.tool_use_id) live.push(b);
      else if (b.type === "text" && liveText) { live.push({ type: "text", text: liveText }); liveText = ""; }
      renderAssistant(el, [...done, ...live], liveText);
    });
    stream.on("text", (d) => { liveText += d; renderAssistant(el, [...done, ...live], liveText); });

    let msg;
    try {
      msg = await stream.finalMessage();
    } finally {
      clearInterval(tick);
    }
    done.push(...msg.content);
    renderAssistant(el, done);
    messages.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason === "pause_turn") continue; // server-side tool loop wants another round
    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.explanation || msg.stop_details?.category || "no reason given";
      el.insertAdjacentHTML("beforeend", `<p class="err">Claude declined this (${esc(why)}).</p>`);
    }
    if (msg.stop_reason === "max_tokens") el.insertAdjacentHTML("beforeend", `<p class="err">Hit the output limit. Ask it to continue.</p>`);
    return { text: done.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"), calls, usage: msg.usage };
  }
  el.insertAdjacentHTML("beforeend", `<p class="err">Still working after ${MAX_ROUNDS} rounds. Say "continue" to keep going.</p>`);
  return { text: done.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"), calls };
}

$("#send").onclick = async () => {
  if (running) return;
  const q = $("#question").value.trim();
  if (!settings.apiKey || !hostReady()) { show("settings"); $("#settings-status").textContent = "Add your host URL, host token and Anthropic key."; return; }
  if (!q) { setStatus("Ask something about the target.", true); return; }
  if (!target && !messages.length && !confirm("No target selected. Ask anyway?")) return;

  $("#question").value = "";
  $("#send").disabled = true;
  $("#stop").hidden = false;
  const before = messages.length;
  try {
    const r = await ask(q);
    const u = r.usage;
    setStatus(`Done · ${r.calls} tool call${r.calls === 1 ? "" : "s"}${u ? ` · ${Math.round((u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)) / 1000)}k in / ${Math.round(u.output_tokens / 1000)}k out` : ""}`);
    $("#send").textContent = "Follow up";
    if (!saveHistory({ at: Date.now(), target: target?.name ?? null, question: q, answer: r.text, model: settings.model })) setStatus("Done (phone storage full, not saved to history).");
  } catch (err) {
    // Roll the transcript back to before this question so a retry starts clean.
    messages.length = before;
    $("#question").value = q;
    if (running?.aborted) setStatus("Stopped. Your question is back in the box.");
    else setStatus(err?.status === 401 ? "Anthropic key rejected. Check Settings." : err?.message || String(err), true);
  } finally {
    running = null;
    $("#send").disabled = false;
    $("#stop").hidden = true;
  }
};

$("#stop").onclick = () => {
  if (!running) return;
  running.aborted = true;
  running.stream.abort();
};

// ---------- history ----------

function saveHistory(entry) {
  const h = store.get("rea.history", []);
  h.unshift(entry);
  return store.set("rea.history", h.slice(0, 60));
}

function renderHistory() {
  const h = store.get("rea.history", []);
  const ul = $("#history-list");
  if (!h.length) { ul.innerHTML = `<li class="empty">Nothing yet.</li>`; return; }
  ul.innerHTML = "";
  for (const e of h) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${esc(e.question.slice(0, 120))}</b>
      <div class="meta">${new Date(e.at).toLocaleString()} · ${esc(e.target ?? "no target")} · ${esc(e.model)}</div>
      <div class="row"><button class="btn small" data-read>Read</button><button class="btn small ghost" data-copy>Copy</button></div>
      <div class="md answer" hidden>${md(e.answer)}</div>`;
    li.querySelector("[data-read]").onclick = (ev) => { const a = li.querySelector(".answer"); a.hidden = !a.hidden; ev.target.textContent = a.hidden ? "Read" : "Hide"; };
    li.querySelector("[data-copy]").onclick = () => navigator.clipboard.writeText(`# ${e.question}\n\n${e.answer}`).catch(() => {});
    ul.appendChild(li);
  }
}
$("#clear-history").onclick = () => { if (confirm("Delete all history on this phone?")) { store.set("rea.history", []); renderHistory(); } };

// ---------- settings ----------

function loadSettingsUI() {
  $("#host-url").value = settings.hostUrl;
  $("#host-token").value = settings.hostToken;
  $("#api-key").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#effort").value = settings.effort;
}
function readSettingsUI() {
  settings = {
    hostUrl: $("#host-url").value.trim().replace(/\/+$/, ""),
    hostToken: $("#host-token").value.trim(),
    apiKey: $("#api-key").value.trim(),
    model: $("#model").value,
    effort: $("#effort").value,
  };
  store.set("rea.settings", settings);
}
const busy = () => { if (running) { $("#settings-status").textContent = "Wait for the current investigation to finish."; } return !!running; };
$("#save-settings").onclick = () => {
  if (busy()) return;
  readSettingsUI();
  const s = $("#settings-status");
  s.className = "status";
  s.textContent = settings.hostUrl && !settings.hostUrl.startsWith("https://") ? "Saved. Note: the host must be https:// or Anthropic can't reach it." : "Saved.";
  pingHost();
};
$("#test-host").onclick = async () => {
  if (busy()) return;
  readSettingsUI();
  const s = $("#settings-status");
  s.className = "status";
  s.innerHTML = '<span class="spinner"></span>Testing…';
  try {
    const up = await pingHost();
    const { files } = await hostFetch("/files");
    s.textContent = `${up ? "REA online" : "Host up, REA still starting"} · token OK · ${files.length} target${files.length === 1 ? "" : "s"}.`;
  } catch (e) {
    s.className = "status err";
    s.textContent = `Host check failed: ${e.message}`;
  }
};

// ---------- boot ----------

renderPresets();
renderTarget();
loadSettingsUI();
pingHost();
if (!hostReady() || !settings.apiKey) show("settings");

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
