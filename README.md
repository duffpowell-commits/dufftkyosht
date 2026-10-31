# Reverse Engineer Anything — phone app

A no-install phone app (PWA) that tears apart anything that works — a post, ad, landing page, product, business, skill, design, codebase, strategy — and hands back:

- **Verdict** – the one real reason it works
- **Formula** – a one-line reusable recipe
- **Components** and **mechanisms** (with evidence from the input)
- **Fill-in-the-blank template** for making your own original version
- **Build steps**, **weak spots**, **remix ideas**

Inputs: pasted text, URLs (Claude fetches them), photos/screenshots from the camera roll or camera, PDFs. Pick a lens (content, product, business, skill, design, code, strategy) and optionally a goal, and the template gets tailored to it.

## Install on your phone

1. Host the folder over HTTPS. Easiest: GitHub repo → Settings → Pages → deploy from branch, root folder.
2. Open the URL on your phone.
   - **iPhone (Safari):** Share → *Add to Home Screen*.
   - **Android (Chrome):** ⋮ → *Install app*. Once installed it shows up in the Android share sheet, so you can share a tweet/article straight into it.
3. Open the app → **Settings** → paste your Anthropic API key → Save.

## How it works

- Pure static files (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`). No build step, no backend.
- Calls the Claude Messages API from the browser with the official `@anthropic-ai/sdk` (loaded from esm.sh, `dangerouslyAllowBrowser: true`), streaming, with a JSON-schema structured output so the result always renders cleanly.
- Default model Claude Opus 5.5; Sonnet 5.5 / Haiku 5.5 selectable for cheaper runs. Opus/Sonnet requests opt into server-side refusal fallbacks (`fallbacks: "default"`).
- URLs are opened with the server-side `web_fetch` tool (toggle in Settings).
- API key + history (last 50) live in `localStorage` on the device only.

## Security note

The API key sits in the phone's browser storage. Fine for a personal app on your own phone; **don't** host this publicly with your key baked in, and set a spend limit on the key in the Anthropic Console. If you ever want to share it with other people, put a tiny proxy in front that holds the key.

## Run locally

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```
