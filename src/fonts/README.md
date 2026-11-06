# Self-hosted fonts

Loaded via `next/font/local` in `src/app/layout.tsx` (replaces `next/font/google`, whose
build-time fetch intermittently crashed `next build`, vercel/next.js#99114). Latin subset only,
as before. Downloaded 2026-11-06 from Google Fonts CSS2 API (fonts.gstatic.com, Chrome UA).

| File | Source URL | Size |
|---|---|---|
| UbuntuSans-latin-normal.woff2 | https://fonts.gstatic.com/s/ubuntusans/v4/co3VmWd6mSRtB7_9UaLWwJnCq5ALePfPu1tPcW2d6TaG.woff2 | 38052 B |
| UbuntuSans-latin-italic.woff2 | https://fonts.gstatic.com/s/ubuntusans/v4/co3TmWd6mSRtB7_9UaLWwLPLmXPrAaRZFVxauS9FrAaE3jI.woff2 | 39052 B |
| Marcellus-latin-400.woff2 | https://fonts.gstatic.com/s/marcellus/v14/wEO_EBrOk8hQLDvIAF81VvoK.woff2 | 14552 B |

Ubuntu Sans v4 is a variable font (wght 100-800), declared as weight `100 800`.

## Licenses
- Ubuntu Sans: **Ubuntu Font Licence 1.0 (UFL)**, NOT OFL. Copyright 2011, 2022, 2023 Canonical Ltd.
  Per google/fonts `ufl/ubuntusans/METADATA.pb` (upstream commit 9554af00fb9d438a12c916df8451c10dcedc9b7e).
  Full text: `UFL-UbuntuSans.txt` (google/fonts `ufl/ubuntusans/LICENCE.txt`).
- Marcellus: SIL OFL 1.1. Copyright (c) 2012, Brian J. Bonislawsky DBA Astigmatic (AOETI), Reserved Font Name "Marcellus".
  Full text: `OFL-Marcellus.txt` (google/fonts `ofl/marcellus/OFL.txt`).

The files are Google-served subsetted woff2, not the original TTFs; the redistributed
license texts come from google/fonts main, not verified against each release tarball.
