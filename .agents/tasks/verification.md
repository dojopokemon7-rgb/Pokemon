# Verification — staging basic-auth hash from env var (staging-basicauth-env)

## What the change does

Replaced the HARDCODED staging `basic_auth` bcrypt placeholder in the Caddyfile with a
Caddy env-substitution `{$STAGING_BASICAUTH_HASH}`, so the real hash lives in the
gitignored root `.env` and is never clobbered by `git reset --hard origin/staging`
deploys.

## DOMAIN plumbing trace (step 2 — how the var reaches the caddy container)

Traced in `docker-compose.yml`:

- The `caddy` service has **no `env_file:` key** — it only declares
  `environment: - DOMAIN=${DOMAIN}`.
- `${DOMAIN}` is **docker-compose variable-substitution**, resolved at compose-parse
  time from Compose's variable sources: the shell environment and the **project default
  env file `.env`** in the compose directory (Compose's automatic `--env-file .env`).
- This is INDEPENDENT of any service's `env_file`. The `app` service's `env_file: - .env`
  and `app-staging`'s `env_file: - .env.staging` inject vars into those CONTAINERS; they
  do NOT affect `${VAR}` interpolation. Compose interpolation always reads the project
  `.env` / shell, never `.env.staging`.
- Conclusion: **`DOMAIN` comes from the root `.env`** (via Compose interpolation into the
  caddy container env), which the Caddyfile then reads as `{$DOMAIN::80}`.

Therefore `STAGING_BASICAUTH_HASH` is plumbed **exactly the same proven way**: added
`- STAGING_BASICAUTH_HASH=${STAGING_BASICAUTH_HASH}` to the caddy service `environment:`,
sourced by Compose from the **root `.env`**, read by the Caddyfile as
`{$STAGING_BASICAUTH_HASH}`. The authoritative placeholder therefore lives in
`.env.example` (root), with a pointer note in `.env.staging.example` explaining the var
does NOT belong there.

## Files changed

- `Caddyfile` — staging block `basic_auth { staging {$STAGING_BASICAUTH_HASH} }` +
  load-bearing comment (why env var, how to generate, where it lives, deploy-survival).
  Prod block untouched.
- `docker-compose.yml` — caddy service `environment:` gains
  `- STAGING_BASICAUTH_HASH=${STAGING_BASICAUTH_HASH}` + comment tracing the root-.env
  source. Nothing else changed.
- `.env.example` (root) — authoritative commented placeholder
  `# STAGING_BASICAUTH_HASH=$2a$14$REPLACE_WITH_BCRYPT_HASH` next to DOMAIN, with
  generate/where instructions.
- `.env.staging.example` — pointer note: the var belongs in the root `.env`, not here
  (shared caddy service, no env_file).
- `docs/CLOUDFLARE_SETUP.md` — new "Staging basic-auth password (env var, survives
  deploys)" subsection replacing the old hand-edit-the-Caddyfile model.

Constraints respected: no `prisma/schema.prisma`, no `src/lib/auth.ts`. No real hash
committed (only the `REPLACE_WITH_BCRYPT_HASH` placeholder).

## Commands run (from the worktree)

```
npm run type-check   → PASS (tsc --noEmit, exit 0, no output)
npm run lint         → PASS (eslint ., exit 0, no output)
```

No tests needed (config + docs only; no `page.tsx` touched, so no build required).

## Caddyfile validation

Docker is installed on the host but the Docker daemon was NOT running in the sandbox
(`failed to connect to the docker API … dockerDesktopLinuxEngine`), so live
`caddy validate` could not be executed here. The operator validates on the Droplet via
`caddy validate` / `docker compose up -d --force-recreate caddy`.

Syntax confidence: `{$STAGING_BASICAUTH_HASH}` uses the IDENTICAL Caddy env-substitution
form already proven in the same file by the prod block's `{$DOMAIN::80}`. Grep confirmed
no real session hash (`cyd.gEbK…`) exists in any tracked file; the only placeholder is
the commented `REPLACE_WITH_BCRYPT_HASH` in `.env.example`.
