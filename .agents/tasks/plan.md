# Implementation Plan — Cloudflare origin-hiding + reverse-proxy/rate-limiter reconciliation

> Work ONLY in the worktree `d:\Pokemon\Pokemon\.worktrees\cloudflare-origin`. Do NOT
> touch the main worktree, `prisma/schema.prisma`, or `src/lib/auth.ts`. Do NOT
> push/deploy/merge-to-origin. Each numbered item is one commit.

## Context / design decisions (grounded in the code I read)

- **Topology change.** Today the app sits behind a SINGLE Caddy reverse proxy with no
  CDN. `src/lib/utils/rate-limit.ts` `clientIp()` trusts `x-real-ip` first because Caddy
  sets it from `{remote_host}` (the real TCP peer) and overwrites any client value, so it
  is unspoofable. Once Cloudflare proxies the domain, Caddy's real peer — and therefore
  `x-real-ip` — becomes a **Cloudflare edge IP**, collapsing every visitor into one
  rate-limit bucket. Cloudflare carries the true visitor IP in `CF-Connecting-IP`.
- **Decision (CHANGE 1): prefer `CF-Connecting-IP`, then keep the existing chain.**
  New order: `CF-Connecting-IP` → `x-real-ip` → first `x-forwarded-for` hop → `"unknown"`.
  This keeps local/dev/test/CI behaviour byte-for-byte identical (none of those set
  `CF-Connecting-IP`), so every existing clientIp test still passes unchanged. Chosen over
  rewriting the chain around `x-forwarded-for` because that would reintroduce the
  attacker-controlled first-hop problem the current comment (audit 10 F2 / 12 F8) exists to
  prevent.
- **Decision — why trusting `CF-Connecting-IP` is safe.** It is only trustworthy because
  the Droplet firewall will be locked so 80/443 accept connections ONLY from Cloudflare's
  published IP ranges. Without that lock an attacker could hit the origin IP directly and
  forge `CF-Connecting-IP`; with it, the header is guaranteed Cloudflare-set = real visitor
  IP. This WHY must live as a load-bearing comment (AGENTS.md RULE 14) in the code and be
  documented in the runbook. The firewall + range-locking is an OUT-OF-REPO operator step.
- **Decision (CHANGE 2): Caddy `trusted_proxies static <cloudflare ranges>` + Cloudflare
  Origin Certificate instead of Let's Encrypt.** Behind the firewall, ACME HTTP-01 from
  Let's Encrypt cannot reach the origin (only Cloudflare IPs may), so automatic HTTPS would
  fail. The prod block switches to a static `tls /etc/caddy/origin/cert.pem
  /etc/caddy/origin/key.pem`, keeping the real domain as the site address (never hardcode
  the IP). `trusted_proxies` makes Caddy derive the client IP from Cloudflare's forwarded
  headers; we additionally pass `CF-Connecting-IP` through explicitly so the app's
  `clientIp()` sees it. Cloudflare SSL/TLS mode = Full (strict) pairs with the origin cert.
- **Decision — staging.** `staging.dojocollect.com` will also be proxied by Cloudflare
  (per the runbook DNS step), so it has the identical ACME-behind-firewall problem. Apply
  the SAME origin-cert approach to the staging block (one Origin Certificate can cover
  `dojocollect.com`, `*.dojocollect.com`). Keep `basic_auth`.
- **Cloudflare IP ranges** (fetched from https://www.cloudflare.com/ips-v4 and
  https://www.cloudflare.com/ips-v6 during planning — these MUST be refreshed periodically):
  - IPv4: `173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
    108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17
    162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22`
  - IPv6: `2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32
    2a06:98c0::/29 2c0f:f248::/32`
- **Verification.** No `page.tsx` is touched, so a build is NOT required. Commands (run from
  the worktree): `npm run type-check`, `npm run lint`, `npm run test:unit`,
  `npm run test:integration`. Pre-existing type errors live ONLY in `src/lib/auth.ts`
  (H-2) and are NOT ours. Caddyfile has no automated test — validate with the
  `caddy validate` container command noted below.

---

## Plan

- [ ] 1. Update `clientIp()` to prefer `CF-Connecting-IP`, then keep the existing chain.
      In `src/lib/utils/rate-limit.ts`, add a FIRST lookup of the `CF-Connecting-IP` header
      (trim; return if non-empty) ahead of the current `x-real-ip` → first-`x-forwarded-for`
      → `"unknown"` logic, which stays exactly as-is. Add/extend the function's doc comment
      and an inline comment (AGENTS.md RULE 14, do NOT strip the existing audit-10-F2/12-F8
      comment) explaining: Cloudflare now fronts Caddy so `x-real-ip`/peer is a Cloudflare
      edge IP; `CF-Connecting-IP` is the real visitor IP and is trustworthy ONLY because the
      Droplet firewall (docs/CLOUDFLARE_SETUP.md) restricts 80/443 to Cloudflare's published
      ranges — without the firewall lock the header is spoofable, with it it is authoritative.
      Files: `src/lib/utils/rate-limit.ts`
      Verify: `npm run type-check` (no NEW errors beyond the pre-existing `src/lib/auth.ts`
      H-2 ones) and `npm run lint` pass.

- [ ] 2. Extend the `clientIp` unit tests for the Cloudflare header.
      In `tests/unit/rate-limit.test.ts`, inside the `describe("clientIp — ...")` block add
      cases: (a) `CF-Connecting-IP` present → it wins; (b) `CF-Connecting-IP` absent →
      `x-real-ip` (assert the existing case still holds); (c) both absent → first
      `x-forwarded-for` hop; (d) none present → `"unknown"`; (e) a FORGED `CF-Connecting-IP`
      alongside `x-real-ip` → still returns `CF-Connecting-IP`, with a test comment that this
      is safe ONLY behind the Cloudflare-only firewall lock. Keep all existing cases.
      Files: `tests/unit/rate-limit.test.ts`
      Verify: `npm run test:unit` — all rate-limit tests pass, including the new ones.
      (Known flake: `add-invalidates-chart.test.tsx` passes when run alone; ignore if it
      flakes in the full unit run.)

      _Commit boundary: items 1-2 together are the CHANGE 1 commit (code + its tests)._

- [ ] 3. Reconcile the Caddyfile for Cloudflare (trusted_proxies + origin cert + CF header).
      In `Caddyfile`: (a) add a GLOBAL options block at the TOP of the file (must be first —
      see the file's own warning about key-less blocks being treated as global) containing
      `servers { trusted_proxies static <all IPv4 + IPv6 ranges from item context> }`, with a
      comment that these are Cloudflare's published ranges, the source URLs
      (https://www.cloudflare.com/ips-v4 and /ips-v6), and a note to refresh them (kept in
      sync with the ufw rules in the runbook). (b) In BOTH the prod `{$DOMAIN::80}` block and
      the `staging.dojocollect.com` block, replace reliance on automatic HTTPS by adding
      `tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem` (Cloudflare Origin
      Certificate; Cloudflare SSL/TLS mode Full (strict)) — keep the domain/env address as
      the site key, never an IP. Add a comment in the prod block that with `{$DOMAIN::80}`
      unset (local dev) the `:80` address serves plain HTTP and the `tls` directive is a
      no-op for that port, but once DOMAIN is set the origin cert is served on 443 and the
      cert files MUST exist before `docker compose up caddy` (ACME is intentionally no longer
      used because the firewall blocks Let's Encrypt HTTP-01). (c) In both `reverse_proxy`
      blocks, explicitly pass the Cloudflare header through with
      `header_up CF-Connecting-IP {header.CF-Connecting-IP}` (documented: this is the header
      `clientIp()` reads). Preserve every existing load-bearing comment (RULE 14), the
      one-block WHY, basic_auth, gzip, security headers, and logging.
      Files: `Caddyfile`
      Verify: `docker run --rm -v "${PWD}/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine
      caddy validate --config /etc/caddy/Caddyfile` reports a valid config (DOMAIN unset is
      fine — it renders `:80`). If Docker is unavailable in the agent environment, note that
      and rely on careful review + the operator running `caddy validate` on the Droplet.

- [ ] 4. Mount the origin-cert directory into the Caddy service.
      In `docker-compose.yml`, add a read-only volume mount to the `caddy` service:
      `./infra/cloudflare-origin:/etc/caddy/origin:ro`, with a comment that the operator
      pastes the Cloudflare-issued Origin Certificate (`cert.pem` + `key.pem`) there and that
      the directory/key are git-ignored (see item 5). Leave the existing `./Caddyfile`,
      `caddy_data`, and `caddy_config` mounts, the `DOMAIN` env, and the 80/443 ports
      untouched.
      Files: `docker-compose.yml`
      Verify: `docker compose -f docker-compose.yml config` prints the merged config with the
      new mount and no YAML errors. (If Docker is unavailable, confirm by review that YAML
      indentation matches the sibling mounts.)

- [ ] 5. Git-ignore the origin cert directory/key — never commit private keys.
      In `.gitignore`, add an entry for the Cloudflare origin cert material, e.g.
      `/infra/cloudflare-origin/` (and explicitly `/infra/cloudflare-origin/*.pem`), with a
      comment that it holds the Cloudflare Origin Certificate private key and must never be
      committed. If a tracked placeholder is wanted, allow a `.gitkeep`/README via a `!`
      negation; otherwise ignore the whole dir.
      Files: `.gitignore`
      Verify: `git check-ignore -v infra/cloudflare-origin/key.pem` prints the matching
      `.gitignore` rule (confirming the key path is ignored); `git status` shows no `.pem`
      files staged.

      _Commit boundary: items 3-5 together are the CHANGE 2 commit (Caddyfile +
      docker-compose + .gitignore)._

- [ ] 6. Write the operator runbook `docs/CLOUDFLARE_SETUP.md`.
      Create the file as an ordered, OUT-OF-REPO operator runbook with exact commands,
      following the house doc style (see `docs/ARCHITECTURE.md` §12 for staging context and
      AGENTS.md §2 for the Droplet/Caddy/staging topology). Sections, in order:
      (1) Add `dojocollect.com` to Cloudflare; switch registrar nameservers to the two
      Cloudflare NS records.
      (2) Cloudflare DNS: A records for root (`@`), `www`, and `staging` → the Droplet IP,
      all set to **Proxied (orange cloud)** so the origin IP is hidden.
      (3) SSL/TLS mode = **Full (strict)**; create an **Origin Certificate** (covers
      `dojocollect.com` + `*.dojocollect.com`); paste `cert.pem` + `key.pem` into
      `./infra/cloudflare-origin/` on the Droplet; `chmod 600` the key.
      (4) Droplet firewall with `ufw`: `sudo ufw allow 22/tcp` FIRST (never lock out SSH),
      then allow 80/443 ONLY from Cloudflare ranges via the loops
      `for ip in $(curl -s https://www.cloudflare.com/ips-v4); do sudo ufw allow from $ip to
      any port 80,443 proto tcp; done` and the matching `/ips-v6` loop, then
      `sudo ufw --force enable`. Explain WHY: hiding the IP via proxied DNS is not enough —
      the firewall closes the direct-IP bypass and is exactly what makes `CF-Connecting-IP`
      trustworthy for the rate-limiter (cross-reference `src/lib/utils/rate-limit.ts`).
      (5) Redeploy Caddy AFTER the cert is in place:
      `docker compose up -d --force-recreate caddy`; verify `https://dojocollect.com` loads
      and that a direct hit to the origin IP is refused
      (`curl -k --resolve dojocollect.com:443:<DROPLET_IP> https://dojocollect.com` fails /
      times out from outside Cloudflare).
      (6) Maintenance note: periodically refresh the Cloudflare IP ranges in BOTH the
      Caddyfile `trusted_proxies` list AND the ufw rules from the two `ips-*` URLs.
      Files: `docs/CLOUDFLARE_SETUP.md`
      Verify: `npm run lint` is unaffected (markdown isn't linted); confirm by review that
      every command is copy-pasteable, SSH is opened before enable, and the file cross-links
      the rate-limiter and Caddyfile. Optionally add a one-line pointer to this runbook from
      `docs/ARCHITECTURE.md` §12 (staging) in the SAME commit.

      _Commit boundary: item 6 is the CHANGE 3 commit (runbook)._

- [ ] 7. Final gate: run the available verification scope and confirm no new breakage.
      Run from the worktree: `npm run type-check`, `npm run lint`, `npm run test:unit`,
      `npm run test:integration`. Confirm the ONLY type errors are the pre-existing
      `src/lib/auth.ts` (H-2) ones and that all rate-limit unit + integration tests pass. Do
      NOT run a build (no page touched) and do NOT run e2e/chart-accuracy. Do NOT push.
      Files: none (verification only)
      Verify: all four commands succeed (type-check shows only the known H-2 auth errors).

## Open assumptions / gaps

- Assumed one Cloudflare Origin Certificate covering `dojocollect.com` + `*.dojocollect.com`
  serves both prod and staging blocks. If the operator prefers separate certs, the staging
  `tls` path can point at a second file pair — note left in the runbook.
- Assumed `caddy validate` via the `caddy:2-alpine` container is the Caddyfile check. If
  Docker isn't available in the implement environment, the implementer should state that and
  defer the live validate to the operator (item 3 verify covers this).
