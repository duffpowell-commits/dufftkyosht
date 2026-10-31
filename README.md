# REA on your phone

A phone app (installable PWA) for **[REA — Reverse Engineer Anything](https://github.com/morluto/rea)**.
Upload an APK, IPA, ASAR, EXE/DLL, ELF, Mach-O, .NET assembly, PyInstaller build, firmware image or zipped JS app from your phone, ask a question ("how does the login work?", "what endpoints and keys does it use?"), and Claude drives REA's full toolset (Ghidra, JADX, REA's static analyzers) on your own server. You watch every tool call and get an evidence-backed answer.

REA itself can't run on a phone (it needs Java, Ghidra, JADX and local process control), so this is split in two:

```
 phone (this PWA) ──upload──▶ your REA host  (Docker: REA 6.8.0 + Ghidra 12.1.4 + JADX, behind a token gateway + HTTPS)
       │                          ▲
       └──question──▶ Claude API ─┘  MCP connector → https://<host>/mcp  (Bearer token)
```

- Target files go **phone → your server only**. Anthropic only sees what REA returns to Claude.
- REA's own HTTP mode has no auth, so it only listens on loopback inside the container. The gateway (`host/gateway.mjs`, no deps) checks a bearer token, proxies `/mcp`, and handles uploads.
- REA has 229 tools (~70k tokens of schemas). The app keeps 7 core entry points loaded and lets Claude find the rest with tool search, so each question doesn't pay for the whole catalog. Claude follows REA's own workflow skill (`vendor/rea-skill.md`, MIT).

## 1. Get a server (no computer needed)

Any Ubuntu/Debian VPS with **≥ 4 GB RAM (8 GB recommended for Ghidra)** and ~10 GB disk: Hetzner, DigitalOcean, Vultr, Lightsail… roughly $6–15/month. You can do all of this from your phone with the provider's app and web console.

SSH (or the provider's web console) in as root and run:

```bash
git clone --depth 1 https://github.com/duffpowell-commits/dufftkyosht.git /opt/rea-phone
sudo bash /opt/rea-phone/host/setup.sh
```

It installs Docker, builds the image (verifying Ghidra and JADX against REA's pinned SHA-256s), gets a free HTTPS cert via `<your-ip>.sslip.io` (no domain needed; set `REA_DOMAIN=your.domain` first to use your own), generates a random token, and prints:

```
Host URL : https://203-0-113-7.sslip.io
Token    : 3f9c…
One-tap phone setup: <APP_URL>/#host=https://203-0-113-7.sslip.io&token=3f9c…
```

The first build takes ~5–10 minutes (Ghidra is ~500 MB).

## 2. Put the app on your phone

1. Host this repo's root over HTTPS. Easiest: GitHub → Settings → Pages → deploy from branch, `/` (root). Your app URL is `https://<user>.github.io/<repo>/`.
2. Open the one-tap link from step 1 on your phone (`<APP_URL>/#host=…&token=…`). It fills in the host and token, then strips them from the address bar.
3. **iPhone:** Share → *Add to Home Screen*. **Android:** ⋮ → *Install app*.
4. Settings → paste your Anthropic API key → **Test host** → Save.

## 3. Use it

- **Targets:** upload a file (tick *Unzip* for a zipped JS/Electron app folder). It becomes the current target.
- **Investigate:** pick a preset (Map it · How does X work? · Endpoints & secrets · Security review · Rebuild it) or ask anything. Tool calls show up live as cards (tap to see input and raw evidence). Ask follow-ups in the same thread; **New** starts fresh.
- **Models:** Opus 5.5 (default, best), Sonnet 5.5 (cheaper), Haiku 5.5 (cheapest, loads all tools, shallow).

## Costs and limits

- REA evidence is big (a 4-line JS app returns ~75 KB). Claude is told to use `detail: "summary"`, but a deep native investigation can still use hundreds of thousands of input tokens. Set a spend limit on your API key.
- The host has no GUI, Hopper, IDA, browser or Android device, so REA's browser/runtime/device tools won't work there. Static analysis (Ghidra, JADX, JS, .NET, archives, firmware metadata) does.
- REA serves one MCP client at a time. Keep one investigation running at a time.
- Very long REA calls (e.g. a first Ghidra analysis of a huge binary) may outlast the API's MCP call window. Ask again; REA reuses its retained analysis.

## Security

- Keep the token secret: anyone with it can run REA on your server and read uploaded targets. To rotate it, edit `host/.env` and run `docker compose up -d`.
- Your Anthropic key and host token live in the phone's localStorage only.
- Only analyze software you're allowed to. REA's [disclaimer](https://github.com/morluto/rea/blob/main/DISCLAIMER.md) applies.

## Files

| Path | What |
|---|---|
| `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icon*` | Phone app (static, no build step) |
| `vendor/rea-skill.md`, `vendor/REA-LICENSE` | REA's workflow skill, vendored (MIT) |
| `host/Dockerfile` | REA 6.8.0 + Ghidra 12.1.4 + JADX headless MCP 0.7.1 + JDK 21 + Node 24 |
| `host/gateway.mjs` | Token auth, `/mcp` proxy, `/upload`, `/files` |
| `host/docker-compose.yml`, `host/Caddyfile` | HTTPS via Caddy (auto cert) |
| `host/setup.sh` | One-shot VPS setup |

Run the app locally: `python3 -m http.server 8080`. Run the gateway against a local REA without Docker: `REA_TOKEN=$(openssl rand -hex 32) node host/gateway.mjs` (needs `rea` on PATH).
