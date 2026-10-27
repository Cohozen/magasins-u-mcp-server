# Security policy

This server holds a live session of the user's Courses U account. A flaw can expose that
account, so please report vulnerabilities privately.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Do not
open a public issue for a security problem.

Useful details: affected version or commit, how to reproduce, and what an attacker could reach
(the MCP endpoint, the noVNC access, the stored session).

## Scope

In scope: authentication of the MCP endpoint, the noVNC access, storage of the session
(`/data`), anything that could leak cookies, tokens or account data through logs or tool output.

Out of scope: the Courses U website itself — report those issues to Système U.
