# AGENTS.md

Guidance for coding agents working on this repository. Read [docs/design.md](docs/design.md)
before changing the browser layer or adding a tool.

## Repository rules

- **This repository is public.** Never commit personal data: store ids, account, order, list or
  receipt ids, real receipts, names, addresses, loyalty card numbers, cookies, tokens, HAR files,
  screenshots or HTML dumps of account pages. Test fixtures are synthetic or anonymised. Public
  catalogue data (product names, EANs, prices) is fine.
- **English everywhere in the repository**: docs, code comments, test names, log messages and
  tool descriptions. Product data stays in French, as the site returns it.
- **The README documents Docker only.** No instructions for a specific host, vendor or hardware:
  users adapt the Docker setup to their own environment.
- **No mention of the maintainer's private projects or personal setup.** Describe consumers
  generically ("an MCP client", "an agent").
- Local, private notes go in `.local/` (git-ignored), never in `docs/`.

## Development

- `npm install`, then `npx patchright install chromium` for local runs.
- `npm run check` (Biome, then TypeScript) and `npm test` (Vitest) must pass before a commit.
- `npm run build` compiles to `dist/`; `npm run dev` runs `src/server.ts` directly.
- Source files are TypeScript run with Node's type stripping: no enums, no parameter properties,
  `import type` for types, relative imports end in `.ts`.
- Keep pure logic (parsing, rules) in tested functions; only thin functions touch the browser.
- Do not add a dependency for what a few lines can do.

## Working against the live site

The site is a real account behind Cloudflare. Use the `live-check` skill for any live test.

- Read-only by default. Ask the maintainer before a login, a write (cart, list, slot, order) or
  anything that changes the account.
- Never solve or click a Cloudflare challenge, never spoof the browser fingerprint, never route
  through a VPN or proxy.
- On a challenge, a login wall or an HTTP 403/429, stop live checks and report.
- Live captures (HAR, page dumps) stay in `.local/` or a scratch directory, never in the repo.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`…), subject in the imperative, in English.
