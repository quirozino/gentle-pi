# Gentle Design canvas over the tailnet

Objective: let the Gentle Design canvas, served by Pi on ddata, open from magneto and r2-d2 through `tailscale serve` with one link, without an SSH tunnel.
Branch: `feat/design-tailnet-canvas` (worktree `gentle-pi-worktrees/design-tailnet`, base `v4.4.0-ddata.3`). Delivery: single local slice, tag `v4.4.0-ddata.4`, global install from tarball. Runner: `node --experimental-strip-types --test <file>`.

## Specs

- S1: "no se abre directo,no hay solucion? para que funcione igual abra directo? y en caso que este en r2-2"
- S2 (agreed flow): Pi shows a link like `https://ddata.tail054f8a.ts.net:8444/?t=<token>`; a click opens the canvas on magneto (Windows browser) or r2-d2 (Android browser, from Moshi); comments, live reload and Implement work as on loopback; `/gentle:design stop` or session end closes it.
- S3: security stays: the server still binds `127.0.0.1` only; the per-server token stays on every route; Host and Origin accept only the loopback names plus the configured tailnet name on the same port; without a valid config nothing changes.
- S4: config file `~/.pi/gentle-ai/design.json` (`{"schema":"gentle-pi.design/v1","publicHost":"<name>.ts.net","ports":[first,last]}`); the server takes the first free port in the range so several Pi sessions can each have a canvas; when every port is busy it falls back to a random loopback-only port and says so.
- S5: in tailnet mode Pi does not try to open a browser on ddata; it shows the tailnet link. Docs describe the one-time `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` setup per port.

## Tasks

- [x] T1 (S2-S5) config reader, server remote origin + port range, open notice, tests, docs — inline
- [ ] T2 (S3) independent verifier (Risk item 2: request guards) — delegated
- [ ] T3 (S2) deploy: tag, pack, global install, tailscale serve mappings, live check — inline

## Log

- L1 (2026-10-28): "como uso gentle desing en pi" → "ok entonces no se abre directo,no hay solucion? para que funcione igual abra directo? y en caso que este en r2-2" → "pero como seria el flujo" → "si".
- L2: probe on ddata (tailscale 1.102.4): `tailscale serve --https=8450 http://127.0.0.1:8450` forwards `Host: ddata.tail054f8a.ts.net:8450`, `Origin` unchanged, `X-Forwarded-Proto: https`, `Tailscale-User-Login`; mapping removed after the probe. Ports 4317/4318 (Gentle Dot) and 7450 already served; range 8450-8459 chosen.
- L3: known limit: Compare frames the app's loopback preview URL, which on a remote client points at that client's own localhost; out of scope.
- L4: T1 checks: focused tests green (design-canvas-server 61, gentle-design 4 new, design-remote 3); RED on base: 3 server tests fail; `npm run typecheck`: 0 diagnostics, no regressions; differential probe without design.json (Host loopback/public/evil, comment POST with loopback and public Origin) identical to v4.4.0-ddata.3. Full suite running.
- L5: full suite (minus 3 files that hang identically on base: auto-mode-sdk, odd-phase-loader, review-loadout-rdd-off-sdk): 8365 pass, 8 fail; every failure also fails on base (float-chrome-roles 1, install-tui-mode-setting 6, grouped Status 1).
