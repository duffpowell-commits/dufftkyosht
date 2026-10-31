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
const REA_BIN = process.env.REA_BIN ?? "rea";

if (TOKEN.length < 24) {
  console.error("REA_TOKEN must be set to a random string of at least 24 characters (try: openssl rand -hex 32)");
  process.exit(1);
}
await mkdir(UPLOAD_DIR, { recursive: true });

// ---------- REA child process ----------

let reaReady = false;
let rea;
function startRea() {
  reaReady = false;
  rea = spawn(REA_BIN, ["mcp", "--http", "--host", "127.0.0.1", "--port", String(REA_PORT)], {
    stdio: ["ignore", "inherit", "pipe"],
    env: process.env,
  });
  rea.stderr.on("data", (buf) => {
    const s = buf.toString();
    process.stderr.write(s);
    if (s.includes("MCP transport listening")) reaReady = true;
  });
  rea.on("exit", (code, sig) => {
    reaReady = false;
    console.error(`rea exited (code=${code} signal=${sig}); restarting in 2s`);
    setTimeout(startRea, 2000);
  });
}
startRea();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { rea?.removeAllListeners("exit"); rea?.kill("SIGTERM"); process.exit(0); });
}

// ---------- helpers ----------

const tokenBuf = Buffer.from(TOKEN);
function authorized(req) {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer (.+)$/.exec(h);
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
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Keep names boring: letters, digits, dot, dash, underscore. No path tricks.
function safeName(raw) {
  const base = path.basename(String(raw || "target")).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (base || "target").slice(0, 120);
}

// ---------- routes ----------

function unzipTo(file, dir) {
  return new Promise((resolve, reject) => {
    // unzip refuses ../ and absolute member paths by default (no zip-slip).
    const p = spawn("unzip", ["-q", "-o", file, "-d", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(err.trim() || `unzip exited ${code}`))));
  });
}

async function handleUpload(req, res, extract) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return json(res, 413, { error: "file too large" });
  const name = `${Date.now()}-${safeName(decodeURIComponent(req.headers["x-filename"] ?? ""))}`;
  const finalPath = path.join(UPLOAD_DIR, name);
  const tmpPath = `${finalPath}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  let aborted = false;
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES && !aborted) {
      aborted = true;
      req.unpipe(out);
      out.destroy();
      rm(tmpPath, { force: true });
      json(res, 413, { error: "file too large" });
      req.destroy();
      return;
    }
    hash.update(chunk);
  });
  req.pipe(out);
  out.on("finish", async () => {
    if (aborted) return;
    await rename(tmpPath, finalPath);
    const sha256 = hash.digest("hex");
    if (extract && /\.zip$/i.test(finalPath)) {
      const dir = finalPath.replace(/\.zip$/i, "");
      try {
        await unzipTo(finalPath, dir);
        await rm(finalPath, { force: true });
        return json(res, 201, { name: path.basename(dir), path: dir, bytes, sha256, extracted: true });
      } catch (e) {
        return json(res, 422, { error: `unzip failed: ${e.message}`, path: finalPath });
      }
    }
    json(res, 201, { name, path: finalPath, bytes, sha256 });
  });
  out.on("error", (e) => { if (!aborted) json(res, 500, { error: e.message }); });
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
  const name = safeName(decodeURIComponent(rawName));
  const p = path.join(UPLOAD_DIR, name);
  if (path.dirname(p) !== UPLOAD_DIR) return json(res, 400, { error: "bad name" });
  await rm(p, { recursive: true, force: true });
  json(res, 200, { deleted: name });
}

function proxyMcp(req, res) {
  if (!reaReady) return json(res, 503, { error: "REA is starting, retry in a few seconds" });
  const headers = { ...req.headers, host: `127.0.0.1:${REA_PORT}` };
  delete headers.authorization; // REA doesn't need it; keep the token at the edge
  delete headers.origin;        // REA rejects foreign Origins; the gateway is the boundary
  const upstream = http.request(
    { host: "127.0.0.1", port: REA_PORT, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => { if (!res.headersSent) json(res, 502, { error: `REA unreachable: ${e.message}` }); else res.end(); });
  req.on("aborted", () => upstream.destroy());
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
    if (url.pathname === "/upload" && req.method === "POST") return await handleUpload(req, res, url.searchParams.get("extract") === "1");
    if (url.pathname === "/files" && req.method === "GET") return await handleList(res);
    if (url.pathname.startsWith("/files/") && req.method === "DELETE") return await handleDelete(res, url.pathname.slice(7));
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});
server.requestTimeout = 0; // long REA calls + big uploads
server.headersTimeout = 60_000;
server.listen(PORT, () => console.error(`gateway listening on :${PORT}, targets in ${UPLOAD_DIR}`));
