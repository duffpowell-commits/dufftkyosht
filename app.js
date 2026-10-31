import Anthropic from "https://esm.sh/@anthropic-ai/sdk";

// ---------- config ----------

const LENSES = [
  { id: "auto", label: "Auto", hint: "Pick whatever framing fits the input best." },
  { id: "content", label: "Content / post", hint: "Treat it as a piece of content (post, thread, video script, ad, email, headline). Focus on hook, structure, pacing, emotional beats, persuasion devices, CTA, and format choices." },
  { id: "product", label: "Product / app", hint: "Treat it as a product. Focus on the core job-to-be-done, feature set, UX flows, onboarding, retention loops, pricing, and what makes it feel good to use." },
  { id: "business", label: "Business model", hint: "Treat it as a business. Focus on customer, value prop, distribution, unit economics, moats, pricing power, and growth loops." },
  { id: "skill", label: "Skill / performance", hint: "Treat it as a skill or performance someone executed. Break it into sub-skills, decision points, practice drills, and the order to learn them." },
  { id: "design", label: "Design / visual", hint: "Treat it as a visual design. Focus on layout grid, hierarchy, typography, color, spacing, imagery, and the emotional effect each choice creates." },
  { id: "tech", label: "Code / system", hint: "Treat it as a technical system. Infer architecture, components, data flow, likely stack, key algorithms, and how to rebuild a minimal version. Only reason from what is shown or publicly documented." },
  { id: "strategy", label: "Strategy / play", hint: "Treat it as a strategic move (marketing campaign, negotiation, trade setup, launch). Focus on the objective, the sequence of moves, the leverage used, and the conditions it depends on." },
];

const MODELS_WITH_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const SYSTEM = `You reverse engineer things. The user gives you something that works (or that they want to understand) — a piece of content, a product, a business, a skill, a design, a system, a strategy — as text, a URL, images, or a PDF.

Your job: figure out *why* it works and hand back a formula the user can reuse to make their own original version.

Rules:
- Be concrete and specific to THIS input. Quote or point at the actual parts. No generic advice that could apply to anything.
- Separate what is observable from what you are inferring; mark inferences with "(inferred)".
- The formula is a short, memorable recipe (e.g. "Contrarian hook → personal proof → 3 numbered lessons → soft CTA").
- The template is fill-in-the-blank with [BRACKETED] slots, ready to paste and use. It must produce an original work, not a copy.
- Steps are ordered and actionable; someone should be able to follow them today.
- Weaknesses: be blunt about what is mediocre, fragile, or overrated.
- If the user gives a goal, tailor the template, steps, and remix ideas to that goal.
- If a URL is given and you can open it, do so before analyzing. If you cannot open it, say so in "caveats" and work from the URL and any other context.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "what_it_is", "verdict", "formula", "components", "mechanisms", "template", "steps", "weaknesses", "remix_ideas", "caveats"],
  properties: {
    title: { type: "string", description: "Short name for the thing analyzed" },
    what_it_is: { type: "string", description: "One or two sentences: what this is and who it is for" },
    verdict: { type: "string", description: "One punchy sentence: the real reason it works" },
    formula: { type: "string", description: "The reusable recipe in one or two lines, using arrows or plus signs" },
    components: {
      type: "array",
      description: "The parts it is built from, in order",
      items: {
        type: "object", additionalProperties: false, required: ["name", "detail"],
        properties: { name: { type: "string" }, detail: { type: "string" } },
      },
    },
    mechanisms: {
      type: "array",
      description: "The underlying principles that make it work, with evidence from the input",
      items: {
        type: "object", additionalProperties: false, required: ["principle", "evidence"],
        properties: { principle: { type: "string" }, evidence: { type: "string" } },
      },
    },
    template: { type: "string", description: "Fill-in-the-blank template with [BRACKETED] slots" },
    steps: { type: "array", items: { type: "string" }, description: "Ordered steps to build your own version" },
    weaknesses: { type: "array", items: { type: "string" } },
    remix_ideas: { type: "array", items: { type: "string" }, description: "Original twists on the formula" },
    caveats: { type: "string", description: "Anything you could not see or verify; empty string if none" },
  },
};

// ---------- state ----------

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

let settings = store.get("settings", { apiKey: "", model: "claude-opus-5-5", effort: "high", web: true });
let lens = "auto";
let attachments = []; // {kind:'image'|'pdf', mediaType, data(base64), preview, name}
let running = false;

// ---------- tabs ----------

function show(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "history") renderHistory();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

// ---------- lenses ----------

function renderLenses() {
  $("#lenses").innerHTML = "";
  for (const l of LENSES) {
    const b = document.createElement("button");
    b.className = "chip" + (l.id === lens ? " active" : "");
    b.textContent = l.label;
    b.onclick = () => { lens = l.id; renderLenses(); };
    $("#lenses").appendChild(b);
  }
}

// ---------- attachments ----------

const MAX_EDGE = 1568;

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function shrinkImage(file) {
  const url = await readAsDataURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; // JPEG has no alpha; keep transparent PNGs readable
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL("image/jpeg", 0.85);
  return { kind: "image", mediaType: "image/jpeg", data: out.split(",")[1], preview: out, name: file.name };
}

$("#file").addEventListener("change", async (e) => {
  for (const f of e.target.files) {
    try {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      const isImg = f.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name);
      if (isPdf) {
        const url = await readAsDataURL(f);
        attachments.push({ kind: "pdf", mediaType: "application/pdf", data: url.split(",")[1], name: f.name });
      } else if (isImg) {
        attachments.push(await shrinkImage(f));
      } else {
        setStatus(`Skipped ${f.name}: only images and PDFs work.`, true);
      }
    } catch (err) {
      setStatus(`Couldn't read ${f.name}: ${err.message}`, true);
    }
  }
  e.target.value = "";
  renderThumbs();
});

function renderThumbs() {
  const box = $("#thumbs");
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = a.kind === "image" ? `<img src="${a.preview}" alt="">` : "PDF";
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = () => { attachments.splice(i, 1); renderThumbs(); };
    d.appendChild(x);
    box.appendChild(d);
  });
}

// ---------- Claude call ----------

function buildUserContent(text, goal) {
  const content = [];
  for (const a of attachments) {
    if (a.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } });
    else content.push({ type: "document", source: { type: "base64", media_type: a.mediaType, data: a.data } });
  }
  const l = LENSES.find((x) => x.id === lens);
  let prompt = `Lens: ${l.label}. ${l.hint}\n\n`;
  prompt += text ? `Thing to reverse engineer:\n<input>\n${text}\n</input>\n` : "Thing to reverse engineer: see the attached file(s).\n";
  if (goal) prompt += `\nMy goal: ${goal}\n`;
  content.push({ type: "text", text: prompt });
  return content;
}

function lastJson(message) {
  const texts = message.content.filter((b) => b.type === "text").map((b) => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    try { return JSON.parse(texts[i]); } catch { /* keep looking */ }
  }
  return JSON.parse(texts.join(""));
}

async function reverseEngineer(text, goal) {
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const model = settings.model;
  const hasUrl = /(https?:\/\/\S+|\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b(\/\S*)?)/i.test(text);

  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { effort: settings.effort, format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: buildUserContent(text, goal) }],
  };
  const betas = [];
  if (MODELS_WITH_FALLBACK.has(model)) {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (settings.web && hasUrl) {
    const fetchType = model === "claude-haiku-5-5" ? "web_fetch_20250910" : "web_fetch_20260209";
    params.tools = [{ type: fetchType, name: "web_fetch", max_uses: 3 }];
  }
  if (betas.length) params.betas = betas;

  // Server tools can pause a long turn; resume up to a few times.
  for (let round = 0; round < 4; round++) {
    let chars = 0;
    const started = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      setStatus(chars ? `Writing the breakdown… ${chars} chars (${s}s)` : `Thinking… ${s}s`, false, true);
    }, 500);
    let msg;
    try {
      // Hard ceiling so a suspended/killed connection can't leave the app stuck.
      const stream = client.beta.messages.stream(params, { timeout: 10 * 60 * 1000, maxRetries: 1 });
      stream.on("text", (d) => { chars += d.length; });
      msg = await stream.finalMessage();
    } finally {
      clearInterval(tick);
    }

    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.explanation || msg.stop_details?.category || "no reason given";
      throw new Error(`Claude declined this one (${why}).`);
    }
    if (msg.stop_reason === "pause_turn") {
      params.messages = [...params.messages, { role: "assistant", content: msg.content }];
      continue;
    }
    if (msg.stop_reason === "max_tokens") throw new Error("Ran out of room. Try a lower depth or a smaller input.");
    return { data: lastJson(msg), model: msg.model, usage: msg.usage };
  }
  throw new Error("Took too many rounds fetching pages. Try pasting the text directly.");
}

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toMarkdown(r) {
  const lines = [
    `# ${r.title}`, "", `**What it is:** ${r.what_it_is}`, "", `**Why it works:** ${r.verdict}`, "",
    "## Formula", "", r.formula, "",
    "## Components", ...r.components.map((c) => `- **${c.name}** — ${c.detail}`), "",
    "## Mechanisms", ...r.mechanisms.map((m) => `- **${m.principle}** — ${m.evidence}`), "",
    "## Template", "", "```", r.template, "```", "",
    "## Build your own", ...r.steps.map((s, i) => `${i + 1}. ${s}`), "",
    "## Weaknesses", ...r.weaknesses.map((w) => `- ${w}`), "",
    "## Remix ideas", ...r.remix_ideas.map((w) => `- ${w}`),
  ];
  if (r.caveats) lines.push("", `_Caveats: ${r.caveats}_`);
  return lines.join("\n");
}

function renderResult(r, el = $("#result")) {
  const list = (arr) => `<ul class="plain">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  el.innerHTML = `
    <div class="card hero">
      <h2>${esc(r.title)}</h2>
      <p class="muted">${esc(r.what_it_is)}</p>
      <p class="verdict">${esc(r.verdict)}</p>
    </div>
    <div class="card"><h3>The formula</h3><div class="formula">${esc(r.formula)}</div></div>
    <div class="card"><h3>Components</h3>${r.components.map((c) => `<div class="item"><b>${esc(c.name)}</b><span class="why">${esc(c.detail)}</span></div>`).join("")}</div>
    <div class="card"><h3>Why it works</h3>${r.mechanisms.map((m) => `<div class="item"><b>${esc(m.principle)}</b><span class="why">${esc(m.evidence)}</span></div>`).join("")}</div>
    <div class="card">
      <div class="row between"><h3>Your template</h3><button class="btn small" data-copy="template">Copy</button></div>
      <div class="template">${esc(r.template)}</div>
    </div>
    <div class="card"><h3>Build your own</h3><ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
    <div class="card"><h3>Weak spots</h3>${list(r.weaknesses)}</div>
    <div class="card"><h3>Remix ideas</h3>${list(r.remix_ideas)}</div>
    ${r.caveats ? `<div class="card"><h3>Caveats</h3><p class="why">${esc(r.caveats)}</p></div>` : ""}
    <div class="actions">
      <button class="btn" data-copy="all">Copy all (Markdown)</button>
      ${navigator.share ? `<button class="btn" data-share>Share</button>` : ""}
    </div>`;
  el.querySelector('[data-copy="template"]').onclick = () => copy(r.template);
  el.querySelector('[data-copy="all"]').onclick = () => copy(toMarkdown(r));
  const sh = el.querySelector("[data-share]");
  if (sh) sh.onclick = () => navigator.share({ title: r.title, text: toMarkdown(r) }).catch(() => {});
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); setStatus("Copied."); }
  catch { setStatus("Copy failed — long-press to select instead.", true); }
}

function setStatus(msg, err = false, spin = false) {
  const s = $("#status");
  s.className = "status" + (err ? " err" : "");
  s.innerHTML = (spin ? '<span class="spinner"></span>' : "") + esc(msg);
}

// ---------- history ----------

function saveHistory(entry) {
  const h = store.get("history", []);
  h.unshift(entry);
  return store.set("history", h.slice(0, 50));
}

function renderHistory() {
  const h = store.get("history", []);
  const ul = $("#history-list");
  if (!h.length) { ul.innerHTML = `<li class="empty">Nothing yet.</li>`; return; }
  ul.innerHTML = "";
  h.forEach((e) => {
    const li = document.createElement("li");
    li.innerHTML = `<b>${esc(e.result.title)}</b>
      <div class="meta">${new Date(e.at).toLocaleString()} · ${esc(e.lens)} · ${esc(e.model)}</div>
      <div class="why">${esc(e.result.formula)}</div>
      <div class="row"><button class="btn small">Open</button></div>`;
    li.querySelector("button").onclick = () => { show("analyze"); renderResult(e.result); setStatus(""); window.scrollTo(0, $("#result").offsetTop - 80); };
    ul.appendChild(li);
  });
}

$("#clear-history").onclick = () => { if (confirm("Delete all history on this device?")) { store.set("history", []); renderHistory(); } };

// ---------- settings ----------

function loadSettingsUI() {
  $("#api-key").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#effort").value = settings.effort;
  $("#web").checked = settings.web;
}
$("#save-settings").onclick = () => {
  settings = { apiKey: $("#api-key").value.trim(), model: $("#model").value, effort: $("#effort").value, web: $("#web").checked };
  store.set("settings", settings);
  $("#settings-status").textContent = "Saved.";
  setTimeout(() => ($("#settings-status").textContent = ""), 1500);
};

// ---------- go ----------

$("#go").onclick = async () => {
  if (running) return;
  const text = $("#input").value.trim();
  const goal = $("#goal").value.trim();
  if (!settings.apiKey) { show("settings"); $("#settings-status").textContent = "Add your API key first."; return; }
  if (!text && !attachments.length) { setStatus("Give me something to tear apart.", true); return; }

  running = true;
  $("#go").disabled = true;
  $("#result").innerHTML = "";
  try {
    const { data, model } = await reverseEngineer(text, goal);
    renderResult(data);
    const saved = saveHistory({ at: Date.now(), lens, model, input: text.slice(0, 500), goal, result: data });
    setStatus(saved ? "Done." : "Done (phone storage full — not saved to history).");
  } catch (err) {
    const msg = err?.status === 401 ? "API key rejected. Check Settings." : err?.message || String(err);
    setStatus(msg, true);
  } finally {
    running = false;
    $("#go").disabled = false;
  }
};

// Share-target / deep link: ?text=...&url=...
const qp = new URLSearchParams(location.search);
const shared = [qp.get("title"), qp.get("text"), qp.get("url")].filter(Boolean).join("\n");
if (shared) $("#input").value = shared;

renderLenses();
loadSettingsUI();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
