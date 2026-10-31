// REA phone gateway: the only thing exposed to the internet.
//
// - Runs `rea mcp --http` on loopback (REA's HTTP mode has no auth by design).
// - Requires `Authorization: Bearer $REA_TOKEN` on everything except /health.
// - /mcp          -> proxied to REA (streamable HTTP, SSE passthrough)
// - POST /upload  -> stores a target file, returns its absolute path for REA tools
//                    (?extract=1 unzips a .zip into a folder, e.g. a JS/Electron app tree)
// - GET  /files   -> lists uploaded targets
// - DELETE /files/<name>
//
// No dependencies beyond Node's standard library.

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, rename } from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.REA_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const REA_PORT = Number(process.env.REA_PORT ?? 8765);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? "/data/targets");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024;
const MAX_EXTRACT_BYTES = Number(process.env.MAX_EXTRACT_MB ?? 4096) * 1024 * 1024;
const MAX_EXTRACT_ENTRIES = Number(process.env.MAX_EXTRACT_ENTRIES ?? 200_000);
const UPLOAD_IDLE_MS = 120_000; // drop uploads that stall for 2 minutes
const REA_BIN = process.env.REA_BIN ?? "rea";

if (TOKEN.length < 24) {
  console.error("REA_TOKEN must be set to a random string of at least 24 characters (try: openssl rand -hex 32)");
  process.exit(1);
}
await mkdir(UPLOAD_DIR, { recursive: true });
// Leftovers from uploads interrupted by a restart.
for (const n of await readdir(UPLOAD_DIR)) if (n.endsWith(".part")) await rm(path.join(UPLOAD_DIR, n), { force: true });

process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));

// ---------- REA child process ----------

let reaReady = false;
let rea;
let shuttingDown = false;

function scheduleRestart(why) {
  reaReady = false;
  if (shuttingDown) return;
  console.error(`rea stopped (${why}); restarting in 3s`);
  setTimeout(startRea, 3000);
}

// Readiness = REA's port accepts connections (not a log string that could change between releases).
function probeRea() {
  if (!rea || rea.exitCode !== null) return;
  const s = net.connect(REA_PORT, "127.0.0.1");
  s.once("connect", () => { s.destroy(); if (!reaReady) console.error("REA is ready"); reaReady = true; });
  s.once("error", () => { s.destroy(); reaReady = false; setTimeout(probeRea, 1000); });
}

function startRea() {
  reaReady = false;
  rea = spawn(REA_BIN, ["mcp", "--http", "--host", "127.0.0.1", "--port", String(REA_PORT)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  rea.once("error", (e) => scheduleRestart(`spawn error: ${e.message}`));
  rea.once("exit", (code, sig) => scheduleRestart(`code=${code} signal=${sig}`));
  setTimeout(probeRea, 500);
}
startRea();
setInterval(() => { if (!reaReady) probeRea(); }, 5000).unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { shuttingDown = true; rea?.kill("SIGTERM"); process.exit(0); });
}

// ---------- helpers ----------

const tokenBuf = Buffer.from(TOKEN);
function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Filename, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Keep names boring: letters, digits, dot, dash, underscore. No path tricks.
function safeName(raw) {
  let decoded = String(raw || "");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
  const base = path.basename(decoded).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (base || "target").slice(0, 120);
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate"];
function stripHopByHop(headers) {
  const out = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  return out;
}

function run(cmd, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => { if (out.length < 8_000_000) out += d; });
    p.stderr.on("data", (d) => { if (err.length < 64_000) err += d; });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("exit", (code, sig) => { clearTimeout(t); resolve({ code, sig, out, err }); });
  });
}

// Inspect a zip before extracting: refuse symlinks (could expose host files such as
// /proc/1/environ to REA), zip bombs, and absurd entry counts.
async function checkZip(file) {
  const list = await run("zipinfo", ["-l", file], { timeoutMs: 120_000 });
  if (list.code !== 0) throw new Error(list.err.trim() || "not a readable zip");
  let total = 0, entries = 0;
  for (const line of list.out.split("\n")) {
    // e.g. "-rw-r--r--  3.0 unx      123 tx      100 defN 26-Oct-31 06:20 path"
    const m = /^([-dlbcps?][-rwxsStT?]{9})\s+\S+\s+\S+\s+(\d+)\s/.exec(line);
    if (!m) continue;
    entries++;
    if (m[1][0] === "l") throw new Error("archive contains symlinks; refusing to extract");
    total += Number(m[2]);
  }
  if (entries > MAX_EXTRACT_ENTRIES) throw new Error(`archive has ${entries} entries (limit ${MAX_EXTRACT_ENTRIES})`);
  if (total > MAX_EXTRACT_BYTES) throw new Error(`archive expands to ${Math.round(total / 1048576)} MB (limit ${MAX_EXTRACT_BYTES / 1048576} MB)`);
}

async function unzipTo(file, dir) {
  await checkZip(file);
  // unzip refuses ../ and absolute member paths by default (no zip-slip).
  const r = await run("unzip", ["-q", "-o", file, "-d", dir]);
  if (r.sig) throw new Error("unzip timed out");
  if (r.code !== 0 && r.code !== 1) throw new Error(r.err.trim() || `unzip exited ${r.code}`);
  // Belt and braces: no symlinks in the served tree, whatever the listing said.
  await run("find", [dir, "-type", "l", "-delete"]);
}

// ---------- routes ----------

function handleUpload(req, res, extract) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return json(res, 413, { error: "file too large" });
  const name = `${Date.now()}-${safeName(req.headers["x-filename"])}`;
  const finalPath = path.join(UPLOAD_DIR, name);
  const tmpPath = `${finalPath}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  let failed = false;
  const out = createWriteStream(tmpPath, { mode: 0o600 });

  const fail = (code, error) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    rm(tmpPath, { force: true }).catch(() => {});
    json(res, code, { error });
    if (!req.complete) req.destroy();
  };

  req.setTimeout(UPLOAD_IDLE_MS, () => fail(408, "upload stalled"));
  req.on("close", () => { if (!req.complete) fail(499, "client went away"); });
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) return fail(413, "file too large");
    hash.update(chunk);
  });
  out.on("error", (e) => fail(500, e.message));
  out.on("finish", async () => {
    if (failed) return;
    try {
      await rename(tmpPath, finalPath);
      const sha256 = hash.digest("hex");
      if (extract && /\.zip$/i.test(finalPath)) {
        const dir = finalPath.replace(/\.zip$/i, "");
        try {
          await unzipTo(finalPath, dir);
          await rm(finalPath, { force: true });
          return json(res, 201, { name: path.basename(dir), path: dir, bytes, sha256, extracted: true });
        } catch (e) {
          await rm(dir, { recursive: true, force: true });
          return json(res, 422, { error: `unzip refused: ${e.message}. The .zip itself was kept.`, name, path: finalPath });
        }
      }
      json(res, 201, { name, path: finalPath, bytes, sha256 });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  req.pipe(out);
}

async function handleList(res) {
  const names = (await readdir(UPLOAD_DIR)).filter((n) => !n.endsWith(".part"));
  const files = await Promise.all(names.map(async (n) => {
    const s = await stat(path.join(UPLOAD_DIR, n));
    return { name: n, path: path.join(UPLOAD_DIR, n), bytes: s.size, modified: s.mtimeMs, dir: s.isDirectory() };
  }));
  files.sort((a, b) => b.modified - a.modified);
  json(res, 200, { files });
}

async function handleDelete(res, rawName) {
  const name = safeName(rawName);
  const p = path.join(UPLOAD_DIR, name);
  if (path.dirname(p) !== UPLOAD_DIR) return json(res, 400, { error: "bad name" });
  await rm(p, { recursive: true, force: true });
  json(res, 200, { deleted: name });
}

function proxyMcp(req, res) {
  if (!reaReady) return json(res, 503, { error: "REA is starting, retry in a few seconds" });
  const headers = stripHopByHop(req.headers);
  headers.host = `127.0.0.1:${REA_PORT}`;
  delete headers.authorization; // REA doesn't need it; keep the token at the edge
  delete headers.origin;        // REA rejects foreign Origins; the gateway is the boundary
  const upstream = http.request(
    { host: "127.0.0.1", port: REA_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => { if (!res.headersSent) json(res, 502, { error: `REA unreachable: ${e.message}` }); else res.end(); });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/health") return json(res, 200, { ok: true, rea: reaReady });
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  try {
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return proxyMcp(req, res);
    if (url.pathname === "/upload" && req.method === "POST") return handleUpload(req, res, url.searchParams.get("extract") === "1");
    if (url.pathname === "/files" && req.method === "GET") return await handleList(res);
    if (url.pathname.startsWith("/files/") && req.method === "DELETE") return await handleDelete(res, url.pathname.slice(7));
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.requestTimeout = 0; // long REA calls + big uploads (stalls are handled per upload)
server.headersTimeout = 60_000;
server.listen(PORT, () => console.error(`gateway listening on :${PORT}, targets in ${UPLOAD_DIR}`));
