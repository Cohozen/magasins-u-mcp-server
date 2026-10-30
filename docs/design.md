# Design

How the server works, why it works that way, and what comes next. Read this before changing the
browser layer or adding a tool.

## Goal

Give an AI agent access to a person's Courses U account (search and compare products, manage
the cart and shopping lists, book a pickup slot, place a drive order paid at pickup, read orders,
receipts and promotions), through a real browser session that the person opens by hand, running
in Docker on their own internet connection.

## Decisions

| Decision | Why |
|---|---|
| **A real browser driven by Patchright, never a plain HTTP client** | Cloudflare Bot Management protects the site: `curl` gets a 403 even on a static JS file. Patchright (a Playwright fork) passes Cloudflare and Turnstile. |
| **Hybrid approach: the browser holds the session, data comes from the site's own internal calls** | The Salesforce Commerce Cloud controllers (`Cart-AddProduct`, `DeliverySlot-GetDeliverySlotsWeb`…) and the account API return JSON or stable HTML fragments. Calling them with `fetch` from the page keeps the browser's cookies and fingerprint without simulating clicks. Clicks are kept for what has no identifiable call. |
| **Manual login, never automated** | The login page is protected by Cloudflare Turnstile. The server stores no password and solves no challenge: the person signs in themselves, in the browser shown through noVNC. |
| **Headed browser on a virtual screen, in production too** | One fingerprint, the same as at login. Headless mode is easier to detect. |
| **Never spoof the fingerprint** (user agent, headers, client hints) | A consistent browser passes better than a disguised one. |
| **The user's own IP address, no VPN and no proxy** | Cloudflare scores IP reputation: challenges show up behind a VPN and not on a home connection. The server has no proxy option on purpose. |
| **One site call at a time, with a random pause between two** | Human pace, and a single session that never steps on itself. |
| **Session cookies saved and injected again at launch, never Cloudflare's** | Session cookies (Salesforce `dwsid`, the ForgeRock SSO cookie) vanish when the browser closes. Without re-injection the session is lost on restart; with it, the session survives. Injecting a stale `cf_clearance`, on the contrary, triggered a challenge. |
| **Keep-alive visits, day and night, never more than 30 minutes apart** | The site drops the session after 30 to 45 minutes of inactivity, even with a tab open (an open tab sends nothing). |
| **A Cloudflare challenge is solved by a person, through noVNC, never by the server** | Ticking the box automatically would be circumventing a protection. The server stops and returns a noVNC link for the agent to pass on. |
| **Two-step order with a confirmation token, pay-at-pickup only** (planned) | An order commits the person. `prepare_order` returns a summary, `place_order` requires the token it produced. No payment data ever goes through the server. |
| **The server's own access token** (`Authorization: Bearer`) | The server does not rely on whatever sits in front of it for protection. |
| **Store fixed by configuration** (`STORE_ID`) | Prices depend on the store, and switching stores can change or empty the cart. Cross-store comparison is out of scope. |

## Architecture

```
MCP client ──HTTP (Streamable HTTP, Bearer)──┐
                                             ▼
                               ┌──────────────────────────┐
                               │ server.ts                │  auth, MCP tools
                               ├──────────────────────────┤
                               │ coursesu/*               │  one function per site action
                               ├──────────────────────────┤
                               │ browser.ts               │  single queue, random pause,
                               │                          │  cookies, keep-alive, challenges
                               └────────────┬─────────────┘
                                            ▼
                         Chrome / Chromium (Patchright) on Xvfb, persistent profile
                                            ▼
                coursesu.com · ext-api.systeme-u.com · moncompte.magasins-u.com
```

The server keeps **no business data** (no database): it reads and acts on the site and only
stores the session. Clients that run fixed flows (a weekly receipt import, for example) are
expected to call the MCP endpoint directly rather than through an LLM.

## Browser layer (`src/browser.ts`)

- **Persistent profile** in the volume (`/data/profile`), with `session.json` next to it (mode
  `0600`). Session cookies are injected at every launch and written again after every successful
  call, to follow their renewal by the site.
- **Stale profile lock**: Chrome locks the profile with a symlink naming the host and process.
  A recreated container has a new hostname, so a lock left by the old one made Chrome refuse
  the profile in a loop. At startup, a lock naming another host or a dead process is removed.
- **Single queue**: one site call at a time, whatever the number of MCP clients.
- **Random pause** between two site requests (`DELAY_MS`, 3 to 8 seconds by default). A tool that
  loads several pages pays the pause on every page.
- **Daily cap** on site requests (`DAILY_REQUEST_CAP`, 300 by default).
- **Keep-alive**: a real page load (not a `fetch`) every 18–26 minutes, day and night, drawn at
  random and capped at 30 minutes (see the session lifetime below). Only a page load lets the silent SSO re-login
  (`Login-OAuthSilentReentryForgerock`) run when the Salesforce session has expired, and lets
  Cloudflare's scripts run. A tool call counts as a visit and postpones the next one. Each visit
  is logged to `visits.jsonl`.
- **Challenge**: a Cloudflare page ("Un instant…" / "Just a moment…") switches the state to
  `needs_challenge`; a logged-out answer switches it to `needs_login`. Both open noVNC and make
  every tool return the link and the instructions. The server polls every 10 seconds, without
  clicking anything, and resumes on its own once the page is clean and the session is back.
- **Refusal**: an HTTP 403 or 429 without a challenge switches the state to `blocked` for
  `BLOCK_COOLDOWN_H` hours (24 by default). Nothing is retried.

### Session lifetime: an idle timeout of 30 to 45 minutes

Measured with `visits.jsonl` on a Docker host: every gap of up to 30 minutes between two visits
kept the session, both gaps of 44 minutes lost it, and sessions lasted over 5.5 hours with short
gaps. So the session ends after 30 to 45 minutes without a visit; a maximum lifetime, if any, is
longer than 5.5 hours. A second session on another machine does not end the first one.

## Tools

Names and parameters of planned tools are indicative. Results are compact JSON, never HTML.

### Read

| Tool | Status | Source | Returns |
|---|---|---|---|
| `session_status` | ✅ | `Account-GetAuthenticationInfo` | signed in or not, store, requests today, human action link |
| `search_products` | ✅ | `/recherche?q=` (tile tracking JSON + visible text) | id, EAN, name, brand, price, unit price, offer, promotion, pack size, washes |
| `get_product` | ✅ | `Product-Show?pid=` (tile JSON + product sheet sections) | tile fields, Nutri-Score, ingredients, nutrition and other sections |
| `get_promotions` | ✅ | `/c/promotions?promos=cardu-promo&start=&sz=` | promoted tiles with offer and end date, 20 per page |
| `get_cart` | ✅ | `/panier` (cart rows: tile JSON, `Quantity` input, visible amounts), `Home-IncludeNavigationSlotTimeInfo` | lines with quantity and discounted amount, estimated total, savings, minimum order, booked slot |
| `get_lists` / `get_list` | ✅ | `/mon-compte/mes-listes`, `…?listID=&start=&sz=` | lists, then a list's products (paginated) |
| `get_recent_purchases` | ✅ | `/mon-compte/mes-listes?isPref=true&start=&sz=` | recently bought products |
| `get_orders` / `get_order` | ✅ | `/mon-compte/mes-commandes`, `/mon-compte/mes-commandes-encours/detail?orderId=` | orders, then an order's lines with quantity and amount |
| `get_slots` | ✅ | `DeliverySlot-GetDeliverySlotsWeb` (csrf token from the cart page) | pickup slots: id, start, end, orders booked |
| `get_receipts` / `get_receipt` | ✅ | account API `POST /moncompte/etickets`, `GET /moncompte/etickets/{id}/{n}/download` (PDF) | transactions, then a parsed till receipt (lines, discounts, totals, consistency checks) |
| `get_loyalty` | ✅ | account area page + account API `GET /mesoffres/v2` | Carte U balance and digital offers |

### Write

| Tool | Status | Source | Safeguard |
|---|---|---|---|
| `set_cart_items` | ✅ | `POST Cart-AddProduct` (`update=true` sets the quantity of a line in the cart, `Quantity=0` removes it; `update=false` adds) | absolute quantities, 24 at most per line; report built from the cart page afterwards |
| `add_list_to_cart` | ✅ | `POST Wishlist-AddToCartWeb` (`listID`) | report of the cart lines that changed |
| `create_list` / `delete_list` | ✅ | `GET Wishlist-CreateMyWishlistWeb` (`listName`), `POST Wishlist-EditListV2` (`action=remove`) | `delete_list` refused without `confirm: true` |
| `add_to_list` / `remove_from_list` | ✅ | `POST Wishlist-AddToLists` / `Wishlist-RemoveFromLists` (`listIds`, `listInfo={"items":[{codeUC, pdtName, quantity}]}`) | list product count before and after |
| `book_slot` | ✅ | `POST Checkout-SetShipping` (`dwfrm_shipping_*` fields, dates as `YYYYMMDD HH:MM:SS`) | slot must be one `get_slots` offers; done only if the header (`Home-IncludeNavigationSlotTimeInfo`) then shows that slot |
| `prepare_order` | planned | checkout up to the summary | returns items, unavailable items, total, slot, payment mode and a token valid 10 minutes |
| `place_order` | planned | final validation | off by default (`ALLOW_PLACE_ORDER=false`); refused if the cart or slot changed since `prepare_order`, or if payment is not at pickup |

Writes call the site's own controllers as its scripts do (`src/coursesu/form.ts`): form fields,
`format=ajax` and the page's `csrf_token`. Controller names come from the `Urls` map every page
embeds; the request formats were read in the site's public scripts.

Every write returns an **execution report**: what was done, what was not and why (out of stock,
capped quantity, substituted product). Without it, the real state and the assumed state drift
apart silently. Write tool descriptions explicitly ask the agent to get the person's approval
before `place_order` and `delete_list`.

## Site notes

- coursesu.com runs on Salesforce Commerce Cloud. Controllers live under
  `/on/demandware.store/Sites-DigitalU-Site/fr_FR/<Controller-Action>`. Writes need the
  `csrf_token` found in the current page.
- Product tiles (`li[data-tc-product-tile]`) carry a tracking JSON: `id`, `EAN`, `brand`,
  `price` (`"unknown"` until a store is selected), `product_cat1..3`, `promotion` (`name`,
  `endDate`). `Product-AdobeProducts` (POST `productslist=pid,pid`) returns the same data in bulk.
- The account area is a separate app calling
  `https://ext-api.systeme-u.com/espaceclient-comptes-process-api/v1` with a bearer token added by
  the page's own script: read those answers by intercepting the page's responses rather than
  handling the token. The one exception is the receipt PDF, which the page only fetches on a
  click: `get_receipt` repeats the page's own request headers for that single call, in memory.
  The API sends dates in UTC without a zone suffix.
- Product grids (search, promotions, lists, recent purchases) and order lines all carry the same
  tracking JSON (`data-tc-product-tile`); grids page with `start` and `sz`.
- Till receipts are PDFs printed on a fixed-pitch grid: `text-grid.ts` rebuilds the grid from the
  PDF text layer (pdfjs), `receipt.ts` reads it and rejects any receipt whose totals do not add
  up.
- Login goes through ForgeRock at `moncompte.magasins-u.com` (OIDC with PKCE), behind Cloudflare
  Turnstile.

## Security and privacy

- Every HTTP request must carry `Authorization: Bearer $MCP_TOKEN`; the server refuses to start
  without a token.
- `session.json` and the profile grant access to the account: they live in the volume, mode
  `0600`, never in the image or in logs.
- Logs never contain cookies, tokens, receipt contents or addresses.
- No payment data goes through the server: pay-at-pickup only.
- Receipts and orders are returned to the caller, never stored by the server.
- **The repository contains no personal data**: test fixtures are synthetic or anonymised, never
  a real receipt or a real account page.

## Tests

- **Unit tests (Vitest)** on pure code: tile parsing, pack sizes, configuration, cookie filtering.
- **No test against the live site in CI.** Live checks are run by hand, read-only, with
  `scripts/call.ts`.

## Milestones

1. **Foundation** ✅: browser layer, keep-alive, noVNC for login and challenges,
   `session_status`, `search_products`, Docker image. Still to measure on a real Docker host:
   challenge frequency with Chrome vs Chromium.
2. **Read** ✅: product page, promotions, cart, lists, orders, slots, receipts (PDF parser),
   loyalty.
3. **Write** ✅: cart, lists, slot booking.
4. **Order**: `prepare_order`, then `place_order` on a real order with a person watching.

## Open points

- Challenge frequency with Chrome vs Chromium, and whether sessions have a maximum lifetime
  beyond 5.5 hours.
- Checkout steps after the slot choice, up to pay-at-pickup validation.
- Fallback if web sessions prove too short: the mobile app may use longer-lived tokens
  (`isMobileApp` shows in the authorisation URLs). Only worth studying if the web session does
  not hold.
