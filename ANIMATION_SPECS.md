# Dojo — Animation & Interaction Specs

Source of truth: [`dojo-prototype`](https://github.com/soulstealpalli/dojo-design) (`dojo-prototype/app.js` + `dojo-prototype/styles.css`), cloned locally to `.reference/dojo-design/`.

This document records every animation/transition found in the reference prototype, notes what does **not** exist there (so we don't invent false parity), and specifies exactly what was implemented in the Next.js app (`src/`) and why, where it deviates.

> **Deviation from the reference, agreed with the user:** the vanilla prototype re-renders its *entire* current screen (`innerHTML = fn()`) on every state change. Because of that, any CSS `animation` (not `transition`) attached to a persistently-true class — `.sheet`'s `up` keyframe, `.wiggle`, `.mark`'s draw/fill — replays on **every** re-render, including on every keystroke while a sheet is open. React preserves DOM identity across re-renders, so this project intentionally plays those animations **once on mount** instead of replaying on every state change. This is more correct for a component-based app and is not considered a regression.

---

## 1. Global primitives (ported to `src/app/globals.css`)

| Primitive | Reference (`styles.css`) | Implemented |
|---|---|---|
| **Primary button "plunk" press** | `.btn:active{transform:translate(5px,5px);box-shadow:0 0 0 0 var(--gold-700)}`, `transition:transform 120ms ease,box-shadow 120ms ease` | `.dojo-btn-primary` gained `box-shadow:5px 5px 0 0 #75581C`, `transition:transform 120ms ease, box-shadow 120ms ease, background-color …`; `:active` collapses the offset to `0 0 0 0` and translates `(5px,5px)`. |
| **Primary button shimmer sweep** | `.btn::after{…linear-gradient…;animation:sweep 2.8s ease-in-out infinite}`; `@keyframes sweep{0%{translateX(-140%) skewX(-24deg)}55%,100%{translateX(240%) skewX(-24deg)}}` | Added `.dojo-btn-primary::after` + `@keyframes dojo-sweep` — identical values, continuous loop, disabled via `:disabled::after{display:none}` and `prefers-reduced-motion`. |
| **Bottom sheet slide-up** | `.sheet{animation:up 200ms ease-out}`; `@keyframes up{from{translateY(100%)}to{translateY(0)}}` + `.scrim` backdrop | Added `.dojo-sheet`/`.dojo-scrim` + `@keyframes dojo-sheet-up` (200ms ease-out) and `dojo-fade-in` for the scrim. Plays once on mount (see deviation note above). |
| **Sign-in mark draw + fill** | `.mark{stroke-dasharray:1;animation:dojo-draw 1400ms cubic-bezier(.4,0,.2,1) forwards, dojo-fill-in 1400ms ease-out forwards}` | Added identical `@keyframes dojo-draw` / `dojo-fill-in` and a `.dojo-mark-animated` class; applied to the `DojoMark` SVG paths in `(auth)/layout.tsx` using `pathLength="1"`. |
| **Wiggle (jiggle-mode)** | `.wiggle{animation:wig 200ms ease-in-out 2}`; `@keyframes wig{0%,100%{rotate(0)}25%{rotate(-1.2deg)}75%{rotate(1.2deg)}}` | Ported verbatim as `.dojo-wiggle` / `@keyframes dojo-wig`. Not currently wired to a screen (no bulk-select portfolio view exists yet in the Next app) — kept as an available primitive for parity, documented here for future use. |
| **Star/plus/toggle 150ms transitions** | `.star{transition:all 150ms}`, `.plus{transition:all 150ms}` | `.dojo-toggle` already had transitions; added `transition: all 150ms ease` to any new toggle-style controls (checkbox squares in multi-select). |
| **Select chevron rotation** | `.select .chev{transition:transform 150ms}`; `.select.open .chev{rotate(180deg)}` | N/A in current app — profile/otp screens use native `<select>`, which can't have a custom chevron transition without replacing the control. Left as-is; noted as a gap, not fabricated. |
| **Error shake** | *Does not exist in the reference.* No shake animation anywhere in `styles.css`. | **New addition**, consistent with the visual language (hard, short, no easing softness): `@keyframes dojo-shake` (4-frame ±6px horizontal snap, 320ms, `steps` feel via short duration) applied via `.dojo-shake` to error text blocks and the OTP digit row on verify failure. |
| **Scan overlay sweep line** | `.scanframe .sweep{animation:dojo-scan 1.8s ease-in-out infinite}`; `@keyframes dojo-scan{0%{top:0}50%{top:calc(100% - 2px)}100%{top:0}}` | Ported verbatim as `.dojo-scanframe .dojo-sweep` / `@keyframes dojo-scan`, applied to the `/scanner` placeholder page's frame. |
| **Skeleton pulse** | Not present in the reference (prototype has no loading skeletons — data is synchronous mock data). The Next app already referenced `animation:"pulse 1.5s ease-in-out infinite"` in `search/page.tsx` but the keyframes were **never defined** (dead reference / bug). | Fixed by defining `@keyframes dojo-pulse` (opacity 1 → 0.4 → 1) and pointing the existing inline style at it. |

All new `@keyframes` and animated rules are wrapped so they respect:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 2. Screen-by-screen

### Login / Signup (Screens 01–02)
- Reference: `.field input` has **no transition on border-color** (hard snap on focus); buttons use the global `.btn` plunk+shimmer; error text is a conditional insert, no animation; password-match hint swaps color instantly.
- Implemented: kept the existing 150ms border-color focus transition (already present, slightly softer than the reference's hard snap — kept because it reads better and the reference itself doesn't forbid it, it simply never specified one). Primary buttons now get the plunk+shimmer via `.dojo-btn-primary`. Server/validation error text (`.dojo-error` blocks) gets `.dojo-shake` applied once when the error first appears (new — no reference behavior to contradict).

### OTP Flow (Screens 03–04)
- **Reference has no OTP screen at all** (`grep` of `app.js`/`data.js` for "otp"/"OTP"/"keypad" returns nothing beyond two dead CSS classes, `.otpbox`/`.keypad`, never instantiated). There is nothing to match here; the existing Next.js implementation (auto-focus/advance, backspace-back, paste-fill, 24s countdown) is original work, not a port.
- Added: `.dojo-shake` on the digit row when `verifyOtp` fails (clears + refocuses, now also shakes — a reasonable, design-consistent addition given none existed to copy). Verify button already disables/enables based on fill state; no "unlock" animation exists in the reference to copy, so a subtle scale/opacity transition was added purely as a new micro-interaction (`transform 120ms ease` on enable, consistent with the button's own plunk timing).

### Profile (Screen 05)
- Reference: avatar "flip" (`flipAvatar`) is a **hard `scaleX` snap, no transition** despite the name — confirmed by reading `.avatar` CSS, no `transition` property present. Location/currency `.select` menus have chevron-rotate (150ms) but the dropdown panel itself has no open/close transition. Public/private `.seg` swap is instant.
- Implemented: added `transition: transform 200ms ease` to the avatar element so the flip actually animates (a deliberate improvement, called out — the reference's "flip" doesn't visually flip). Currency `<select>` and public/private `Toggle` keep their existing transitions (toggle was already animated pre-existing, ahead of the reference which never uses `.toggle` in any real screen).

### Search (Screens 06–08)
- Reference: card grid has no fade-in (`searchResults()` inserts static markup), scan overlay has the sweep line (ported, see above), multi-select uses `.check` boxes with **no transition** (instant) and `.plus`/`.star` with 150ms transitions.
- Implemented: `/scanner` placeholder gets the `.dojo-scanframe`/sweep treatment. Card grid tiles (`CardTile` in `search/page.tsx`) get a staggered fade-up on mount (`dojo-fade-up`, new — reference has nothing to copy since its grid never animates). Multi-select checkbox in `search/multi/page.tsx` gets a 150ms background/border transition (matching the `.star`/`.plus` timing rather than the un-animated `.check`, since a smooth toggle reads better and 150ms is the established value elsewhere in the design system).

### Dashboard (Screens 09–10)
- Reference: portfolio value, deltas, and the SVG chart are all **fully static** — no count-up, no chart draw-in exists anywhere in `app.js` (`chart()` is a pure synchronous SVG string generator). Market movers rows and collection chips have no hover/transition defined.
- Implemented: added a count-up tween for the portfolio value on mount (new, no reference to contradict), a stroke-draw-in for the SVG sparkline polyline (`stroke-dasharray`/`dashoffset`, mirroring the *technique* used by the reference's `.mark` logo draw, applied here to the chart line since the reference never chart-animates), and a 150ms hover/active transition on collection chips.

---

## 3. Explicit non-matches (do not claim otherwise)

- No OTP screen exists in the reference — anything under `/otp`, `/verify-otp` is original design-consistent work.
- No portfolio bulk-select / `.wiggle` consumer exists yet in the Next app's routes (`/portfolio` is out of current scope) — `.dojo-wiggle` is available but unused.
- Trading floor (`SCREENS.shop`, deal-closing interstitial with the stepped-dot loader) is explicitly called out in the reference's own README as **cut from the reviewed flow** and intentionally unreachable — not ported, out of scope.
- Native `<select>` elements (currency, country code) cannot get the reference's custom chevron-rotate without being replaced by a custom listbox component — not done in this pass, flagged as a gap rather than silently skipped.
