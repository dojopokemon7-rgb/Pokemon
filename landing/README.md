# Dojo marketing landing (source)

Vite 5 + React 18 multi-page project. The **built output is committed to
`public/landing/`** and served by the Next app, so Docker builds and deploys never
need this folder (it is excluded from the Docker context, tsconfig, eslint and vitest).

## Pages

| Page | HTML entry | Served at | Next route handler |
|---|---|---|---|
| Home | `index.html` | `/` | `src/app/route.ts` |
| Privacy policy | `privacy.html` | `/privacy` | `src/app/privacy/route.ts` |
| CGC grading services | `grading-services.html` | `/grading-services` | `src/app/grading-services/route.ts` |
| Contact | `contact.html` | `/contact` | `src/app/contact/route.ts` |

Hashed assets are served from `/landing/*`. The forms post to the Next app:
`/api/grading/notify` (grading page) and `/api/contact` (contact page).

## Install and build

```powershell
cd landing
npm ci                 # once, installs into landing/node_modules
cd ..
npm run landing:build  # from the repo root
```

`npm run landing:build` (`scripts/build-landing.mjs`, plain Node, works on Windows)
builds with `--base=/landing/` into a temp dir, then replaces
`public/landing/*.html` and `public/landing/assets/` (stale hashed files are deleted).
`brand/`, `logos/` and `fonts/` are copied over file by file and never emptied.
Commit the resulting `public/landing/` changes together with the source change.

Local preview of the source: `npm run dev` inside `landing/` (port 5173, proxies `/api` to
the Next app on port 3000; note that a form submit would then hit that app for real).

## Notes

- `src/lib/product.js` points sign up / log in at the app (`/signup`, `/login`).
- Fonts are self-hosted (`public/fonts`, `@font-face` in `src/styles/tokens.css`); there is
  no runtime request to Google Fonts.
- GA4 (`G-JZKE2D8E9V`) with Consent Mode v2 is in each page's `<head>`; the consent banner
  (`src/components/ConsentBanner.jsx`) uses the app's `dojo-analytics-consent` key.
- Files in `public/` are not rebased inside JS strings; use `import.meta.env.BASE_URL`
  (see `BackedBy.jsx`).
- **Removed:** the old Cloudflare Worker (`src/worker/`, `wrangler.jsonc`, `schema.sql`) and the
  `wrangler` dependency. The Next app now implements `/api/grading/notify`.
- This source was reconstructed from the earlier `dojo-landing` folder plus the deployed
  build (the fixed working copy was lost), and verified against `public/landing` as of
  commit `c7b49a4`: identical CSS, JS (modulo minifier identifier names) and HTML, same file
  set. Only the 3 pre-existing pages were compared; `contact` is new.
- Large unused design originals (`src/assets/floor/original/*.png`, ~5 MB) and the
  `Price Triggers.dc.html` prototype were left out of the repo.
