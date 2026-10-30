# Magasins U MCP server

[![CI](https://github.com/Cohozen/magasins-u-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Cohozen/magasins-u-mcp-server/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Cohozen/magasins-u-mcp-server?sort=semver)](https://github.com/Cohozen/magasins-u-mcp-server/releases)
[![Image](https://img.shields.io/badge/image-ghcr.io-blue?logo=docker&logoColor=white)](https://github.com/Cohozen/magasins-u-mcp-server/pkgs/container/magasins-u-mcp-server)
[![License: MIT](https://img.shields.io/github/license/Cohozen/magasins-u-mcp-server)](LICENSE)

An unofficial [MCP](https://modelcontextprotocol.io) server that gives an AI agent access to
**your own** [Courses U](https://www.coursesu.com) account (Super U, Hyper U, U Express grocery
drive in France): search and compare products today; cart, shopping lists, pickup slots, drive
orders, receipts and promotions in later versions (see [the design](docs/design.md)).

It drives a real browser, with a session that **you** open by hand, and runs in Docker on your
own internet connection.

> [!WARNING]
> **Unofficial project, not affiliated with Système U or Coopérative U in any way.** Automating
> an account may breach the site's terms of use and lead to the account being restricted or
> suspended. **Use it at your own risk**; the authors accept no liability (see the
> [license](LICENSE)).
>
> Read the site's [legal notice](https://www.coursesu.com/mentions-legales) and its terms of sale
> (*CGV*, shown once a store is selected) before use. The legal notice states that extracting its
> database, even partially, may incur civil and criminal liability: this server is meant for the
> personal use of your own account at a human pace, never for collecting catalogue data.

## Tools

| Tool | What it does |
|---|---|
| `session_status` | Signed in or not, selected store, requests made today; the link to open when a human action is needed. |
| `search_products` | Searches the selected store: price, price per kilo or litre, promotion, pack size, price per wash for laundry detergent. |
| `get_product` | A product sheet: Nutri-Score, ingredients, nutrition values and the other sections shown on the site. |
| `get_promotions` | Products on promotion in the selected store, 20 per page. |
| `get_cart` | The cart: lines with quantity and amount after multi-buy discounts, estimated total, savings, booked pickup slot. |
| `get_lists` / `get_list` | The account's shopping lists, then one list's products with current prices. |
| `get_recent_purchases` | Products bought before ("Mes achats récents"). |
| `get_orders` / `get_order` | Drive orders, then one order's lines with quantities and amounts. |
| `get_slots` | Drive pickup slots of the coming days. Reading them books nothing. |
| `get_receipts` / `get_receipt` | Carte U purchases of the last months, then one till receipt read line by line and checked for consistency. |
| `get_loyalty` | Carte U balance and digital offers (available, activated, used). |

Tools that change the account:

| Tool | What it does |
|---|---|
| `set_cart_items` | Sets cart quantities (0 removes) and reports, product by product, what the cart holds afterwards. |
| `add_list_to_cart` | Adds a shopping list's available products to the cart. |
| `create_list` / `delete_list` | Creates a list; deletes one only with `confirm: true`. |
| `add_to_list` / `remove_from_list` | Adds products to a list or removes them. |
| `book_slot` | Reserves a drive pickup slot. Nothing is ordered or paid. |

Placing an order is not supported yet.

Product data is returned in French, as shown on the site.

## How it works

- **A real browser** (Google Chrome or Chromium, through
  [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)), shown on a virtual screen
  inside the container. The site sits behind Cloudflare: a plain HTTP client is refused.
- **You sign in yourself**, through noVNC in your own browser. The server never knows your
  password and never solves a Cloudflare check for you.
- **Human pace**: one site call at a time, 3 to 8 seconds between two requests, 300 requests a
  day at most.
- **Session upkeep**: the site drops the session after 30 to 45 minutes of inactivity, so the
  server reloads a page every 18 to 26 minutes, day and night, at irregular intervals. Each
  visit is logged in `/data/visits.jsonl`.
- **Stop rather than insist**: expired session or Cloudflare check → the server stops, opens
  noVNC and the tool returns the link to open. The site refuses access (HTTP 403/429) → 24-hour
  pause.

### Your own IP address, not a VPN

Cloudflare scores the reputation of the IP address: behind a VPN or a proxy, checks pile up. Run
the server from home and **make sure the Docker host does not go out through a VPN**. The server
deliberately has no proxy option.

## Installation (Docker)

Requirements: Docker with Compose, about 1 GB of free RAM. The published image is **x86_64**
(Google Chrome only ships for that platform); on ARM, build it yourself with
`BROWSER_CHANNEL=chromium`.

```bash
git clone https://github.com/Cohozen/magasins-u-mcp-server.git && cd magasins-u-mcp-server
cp .env.example .env
# Set at least MCP_TOKEN (openssl rand -base64 32) and VNC_HOST (the host's local IP)
docker compose pull          # published image (x86_64)
docker compose up -d         # or: docker compose up -d --build, to build it locally
docker compose logs -f
```

Releases follow [semantic versioning](https://semver.org); each one publishes
`ghcr.io/cohozen/magasins-u-mcp-server:<version>` and `:latest`. To pin a version, set the `image`
tag in `docker-compose.yml`.

### First login

On first start there is no session: the log shows a `noVNC access opened` line with a link like
`http://<VNC_HOST>:6080/vnc.html?autoconnect=1&...`. The `session_status` tool returns the same
link.

1. Open that link from a device on the local network.
2. In the browser shown, click **Se connecter** and sign in as usual, passing the Cloudflare check
   yourself.
3. That's it: the server notices the login within seconds, closes noVNC and saves the session.

The same steps apply when the session expires or Cloudflare asks for a check. An unused noVNC link
closes after 30 minutes; the next call opens a new one.

### Connecting the agent

- URL: `http(s)://<host>:8000/mcp` (*Streamable HTTP* transport)
- Header: `Authorization: Bearer <MCP_TOKEN>`

When exposed to the internet (through a tunnel or a reverse proxy), expose port 8000 only. **Port
6080 (noVNC) stays on the local network.**

## Configuration

Every variable is described in [.env.example](.env.example). The main ones:

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TOKEN` | — | Token required in `Authorization: Bearer` (mandatory, 24 characters at least) |
| `VNC_HOST` | `<docker-host-ip>` | Local address used in the noVNC link |
| `STORE_ID` | — | Expected store; `session_status` warns on a mismatch |
| `BROWSER_CHANNEL` | `chrome` (Compose) | `chrome` or `chromium` |
| `DELAY_MS` | `3000-8000` | Random pause between two site requests |
| `DAILY_REQUEST_CAP` | `300` | Daily cap on site requests |
| `KEEPALIVE_DAY_MIN` / `KEEPALIVE_NIGHT_MIN` | `18-26` / `18-26` | Keep-alive interval, in minutes (30 at most: the site drops the session after 30 to 45 idle minutes) |

## Data and security

The `/data` volume holds the browser profile, `session.json` (session cookies, mode `0600`) and
`visits.jsonl`. **These files grant access to your account**: do not copy them anywhere else. The
server stores no password, no payment data and no receipts.

## Development

```bash
npm install
npx patchright install chromium
MCP_TOKEN=a-long-enough-development-token npm run dev
```

On macOS there is no noVNC: the browser window opens directly and you sign in there.
`scripts/call.ts` calls a tool by hand.

| Command | Effect |
|---|---|
| `npm run check` | Biome, then TypeScript |
| `npm test` | Unit tests (Vitest), no access to the site |
| `npm run build` | Compiles to `dist/` |

## Acknowledgements

The approach (real browser, session opened by hand, Docker) comes from
[linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server).

## License

[MIT](LICENSE).
