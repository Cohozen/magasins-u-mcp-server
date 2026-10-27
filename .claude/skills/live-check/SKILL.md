---
name: live-check
description: Run the MCP server locally against the real coursesu.com site and call its tools read-only, to verify a change end to end. Use when asked to test, verify or try a tool "for real", "en vrai", or against the live site.
---

# Live check

Verifies the server against the real site, read-only, on the developer's machine.

## Rules

- Read-only. Never call a write tool (cart, list, slot, order) without the maintainer's explicit
  approval for that call.
- Never click or solve a Cloudflare challenge. On a challenge, a login wall or an HTTP 403/429,
  stop and report.
- Keep the default pacing (`DELAY_MS`), or at least `1500-3000`. A live check is a handful of
  calls, not a loop.
- Tool output contains personal data (orders, receipts, lists): read it, summarise it, never write
  it into the repository. Scratch files go to a scratch directory or `.local/`.

## Steps

1. Build-free start, with a throwaway token and the local data directory (git-ignored):

   ```bash
   MCP_TOKEN=local-check-0123456789abcdef HOST=127.0.0.1 PORT=8765 DELAY_MS=1500-3000 \
     node src/server.ts > "$SCRATCH/server.log" 2>&1 &
   ```

   Run it in the background and keep its PID. Wait for the `startup probe` or `task` line with
   `"label":"probe"` in the log.

2. If the log says `human action required` with `needs_login`, ask the maintainer to sign in
   in the Chromium window that opened (on macOS there is no noVNC). The server logs
   `session restored` on its own once signed in; do not poll the site yourself.

3. Call tools with the bundled client:

   ```bash
   export MCP_URL=http://127.0.0.1:8765/mcp MCP_TOKEN=local-check-0123456789abcdef
   node scripts/call.ts                       # list tools
   node scripts/call.ts session_status
   node scripts/call.ts search_products '{"query":"lessive liquide"}'
   ```

4. Check the answers against what the tool promises (fields present, no nulls where data is
   expected), and the log for `task failed` lines.

5. Stop the server with `kill -TERM <pid>` on the Node PID itself (not `pkill -f`, which also
   hits the wrapping shell). Expect exit code 0 and a fresh `data/session.json`.

## After the check

- `data/` holds a live session of the maintainer's account: mention it, and offer to delete it
  when the session is no longer needed.
- Report what was verified live and what was not.
