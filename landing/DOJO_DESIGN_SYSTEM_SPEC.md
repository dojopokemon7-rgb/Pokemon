# Dojo Design System — Spec

Dojo is a premium collectibles marketplace built for trust. Users track trading cards, sealed product, and graded cards as a portfolio — performance graphs, gain/loss, market movers — with a lightweight social layer ("the floor").

Visual language: **tactile, high-contrast, "plunk."** Hard offset shadows (never blur), flat saturated color blocking, pressable surfaces with explicit elevated/pressed states, confident condensed geometric type. This is an **original brand** inspired by the open-source NeoPOP design principles (CRED) — not a recreation of CRED's UI. Reference: https://github.com/CRED-CLUB/neopop-web (mechanics only — colors/type/copy are original to Dojo). Icons sourced from https://github.com/lucide-icons/lucide.

There is **no logo**. Render the wordmark as plain type: `DOJO`, Archivo 800 weight, 87–112% width, uppercase, wide tracking. Never draw a mark.

---

## 1. Voice & content

- Calm, confident, a little terse. Collector-to-collector, never corporate. No hype words ("revolutionary," "seamless").
- **Casing split (the signature):** UI labels/buttons are UPPERCASE (`SCAN A CARD`, `MARKET MOVERS`). Body copy and serif headings run lowercase-leaning sentence case, even at sentence starts ("the collector's edge," "welcome to the dojo").
- Second person ("your collection," "you're up 12.4%"). "We" only in onboarding/ceremony.
- Numbers lead. Headlines are often just a number. Deltas are always signed with hard triangles: `▲ +12.4%` (jade), `▼ −3.2%` (vermilion). Currency shows cents on hero values (`$48,290.15`), rounds elsewhere.
- No emoji, ever. Only unicode geometric glyphs as ornament: `▲ ▼ ◆ ·`
- Example copy: "Added to portfolio — Charizard Base Set Holo is now tracked." / "Scan failed. Try again with better lighting."

## 2. Color tokens

Dark is the default theme (`:root`). Light ("showroom") is `[data-theme="light"]`.

**Ink (blacks)**
- `--ink-900 #0D0D0D` — app background
- `--ink-800 #121212` — card background
- `--ink-700 #161616` — raised background
- `--ink-600 #1E1E1E`
- `--ink-500 #3D3D3D` — deep edge
- `--ink-400 #8A8A8A` — muted / disabled

**Paper (whites)**
- `--paper-100 #FFFFFF` · `--paper-200 #FBFBFB` · `--paper-300 #EFEFEF` · `--paper-400 #E0E0E0` · `--paper-500 #D2D2D2`

**Gold Leaf (signature accent)**
- `--gold-100 #FBF1DA` · `200 #F6E2B4` · `300 #F0D289` · `400 #ECC35F` · `500 #E9B43B` (Dojo Gold) · `600 #A37E29` · `700 #755A1E` · `800 #463612`

**Jade (gains/success):** `100 #DCF7EC` · `200 #A8ECD1` · `300 #5FDCAB` · `400 #23CE8C` · `500 #0AC27E` · `600 #078857` · `700 #056140` · `800 #033A26`

**Vermilion (losses/error):** `100 #FDE4E0` · `200 #F9B6AC` · `300 #F58270` · `400 #F25B44` · `500 #EF4423` · `600 #A73018` · `700 #782212` · `800 #48150B`

**Amber (warning):** `100 #FBE8CC` · `200 #F7D199` · `300 #F3B966` · `400 #F0A73F` · `500 #EE9A1F` · `600 #A76C16` · `700 #784D10` · `800 #482E09`

**Semantic (dark default)**
```
--surface-app: var(--ink-900);      --surface-card: var(--ink-800);
--surface-raised: var(--ink-700);   --surface-inverse: var(--paper-100);

--text-heading: rgba(255,255,255,.9);    --text-subheading: rgba(255,255,255,.7);
--text-body: rgba(255,255,255,.5);       --text-faint: rgba(255,255,255,.3);
--text-on-accent: #0D0D0D;               --text-inverse: rgba(13,13,13,.9);

--stroke-card: rgba(255,255,255,.1);     --stroke-strong: var(--paper-100);
--divider: rgba(255,255,255,.1);

--accent: var(--gold-500);   --accent-strong: var(--gold-400);
--positive: var(--jade-500); --negative: var(--verm-500); --warning: var(--amber-500);

/* plunk edges */
--edge-bottom: var(--ink-500);   --edge-right: var(--ink-400);
--edge-accent-bottom: var(--gold-700);  --edge-accent-right: var(--gold-600);

/* controls */
--control-bg: var(--ink-900); --control-border: var(--paper-100);
--control-checked-bg: var(--paper-100); --control-mark: var(--ink-900);
--field-placeholder: rgba(255,255,255,.3); --field-caret: var(--gold-500);
```

**Light theme (`[data-theme="light"]`) overrides**
```
--surface-app: var(--paper-200); --surface-card: var(--paper-100); --surface-raised: var(--paper-300);
--surface-inverse: var(--ink-900);
--text-heading: rgba(13,13,13,.9); --text-subheading: rgba(13,13,13,.7);
--text-body: rgba(13,13,13,.5); --text-faint: rgba(13,13,13,.3); --text-inverse: rgba(255,255,255,.9);
--stroke-card: rgba(13,13,13,.1); --stroke-strong: var(--ink-900); --divider: rgba(13,13,13,.1);
--edge-bottom: var(--ink-400); --edge-right: var(--paper-400);
--edge-accent-bottom: var(--gold-600); --edge-accent-right: var(--gold-300);
--control-bg: var(--paper-100); --control-border: var(--ink-900);
--control-checked-bg: var(--ink-900); --control-mark: var(--paper-100);
--field-placeholder: rgba(13,13,13,.3); --field-caret: var(--gold-600);
```

Rule: **flat and saturated fills only.** No gradients, no glows, no glassmorphism/blur transparency.

## 3. Typography

Fonts (Google Fonts CDN, no binaries): **Archivo** (variable, wght 400–900, wdth 75–125%) and **Marcellus** (400, serif).
```
@import url('https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,75..125,400..900&family=Marcellus&display=swap');
```

- `--font-display` / `--font-body`: `'Archivo', 'Helvetica Neue', sans-serif`
- `--font-serif`: `'Marcellus', 'Georgia', serif` — reserved for screen headers / ceremony moments only
- Width axis: condensed `87%` (headlines/numbers), normal `100%` (body), expanded `112%` (caps labels)
- Tracking: caps `0.14em`, tight `-0.01em`
- Scale (px): 44 / 34 / 28 / 22 / 20 / 18 / 16 / 15 / 14 / 13 / 12 / 11 / 10
- Numbers: always `font-variant-numeric: tabular-nums`

Type-scale classes (`.t-*`), weight/stretch/size/line-height/color as shown:
| Class | Weight | Stretch | Size | Line-height | Use |
|---|---|---|---|---|---|
| `.t-hero` | 800 | 87% | 44px | 1.05 | hero numbers |
| `.t-h1` | 800 | 87% | 34px | 1.1 | screen title |
| `.t-h2` | 800 | 87% | 28px | 1.15 | section title |
| `.t-h3` | 700 | normal | 22px | 1.2 | card title |
| `.t-h4` | 700 | normal | 18px | 1.25 | subsection |
| `.t-h5` | 700 | normal | 14px | 1.3 | small heading |
| `.t-num` | 800 | 87% | — | — | tabular numeric values |
| `.t-body` | 400 | normal | 14px | 1.5 | body text, 50% alpha |
| `.t-body-md` | 500 | normal | 14px | 1.5 | body emphasis, 70% alpha |
| `.t-small` | 400 | normal | 12px | 1.45 | captions |
| `.t-caps` | 700 | 112% | 10px | — | uppercase micro-labels, 0.14em tracking |
| `.t-caps-lg` | 800 | 112% | 12px | — | uppercase labels, larger |
| `.t-serif` | 400 (Marcellus) | — | 28px | 1.25 | editorial heading |

Text color alphas are fixed: heading 90%, subheading 70%, body 50%, faint 30% (of white on dark / ink on light).

## 4. Spacing & geometry

5px base unit:
```
--sp-1: 5px  --sp-2: 10px  --sp-3: 15px  --sp-4: 20px
--sp-5: 25px --sp-6: 30px  --sp-8: 40px  --sp-10: 50px  --sp-12: 60px
```
- Page padding: `30px` left, `15px` right (`--page-pad-left` / `--page-pad-right`)
- Sections separated ~26–30px, introduced with a caps label
- **Radius: 0px everywhere** (`--radius-sharp`). Only exceptions: Toast (4px, `--radius-soft`) and Radio (circle — the one round control).
- Hairline strokes at 10% alpha; strong strokes are full white/ink.

## 5. Elevation — "the plunk"

No blur, ever. Interactive elements build a hard offset edge from skewed (45°) solid color blocks: darker block below, lighter block to the right.
- Edge width: `--plunk-w: 3px` (controls), `--plunk-w-lg: 6px` (hero cards)
- **Pressed state:** the face translates down-right by the edge width and the edges collapse to nothing — 120ms ease-in-out.
- Checkbox is the inverse: pressing pushes the check *into* the surface (top/left plunk appears instead).
- Static (non-interactive) blocks may use a simple two-tone `box-shadow` instead of built edge divs:
```
.hard-shadow        { box-shadow: 3px 3px 0 0 var(--edge-bottom); }
.hard-shadow-lg     { box-shadow: 6px 6px 0 0 var(--edge-bottom); }
.hard-shadow-accent { box-shadow: 6px 6px 0 0 var(--edge-accent-bottom); }
```
- Every interactive component needs three states: default (elevated), pressed (collapsed), disabled (ink-400 fill, 50% text, transparent edges). Treat desktop hover as a slight pre-press; mobile press is primary.

## 6. Motion

```
--dur-press: 120ms   /* plunk press/release */
--dur-fast: 150ms    /* checks, toggles, color swaps */
--dur-move: 200ms    /* meters, sheets */
--ease-mech: ease-in-out             /* plunk edges */
--ease-snap: cubic-bezier(0.2,0,0,1) /* entrances, sheets */
```
Snappy and mechanical only. Never spring, bounce, overshoot, or float. No infinite ambient animation.

## 7. Iconography

- Lucide (2px stroke, round caps), SVG only, always `currentColor`, copied locally rather than referencing this open-source repo directly. No icon font, no emoji.
- Directional glyphs (`chevron`, `pointer`, long arrow, `cross`) use a square-cap 1.5px-stroke geometry distinct from Lucide's rounder caps — built into the Icon component and Button/Back.
- Available icon names: `house, trending-up, trending-down, scan-line, users, user, bell, plus, search, chevron-right, chevron-down, arrow-up-right, arrow-down-right, star, shield-check, package, layers, wallet, heart, message-circle, x, settings, chevron, pointer, cross`
- Unicode `▲ ▼ ◆ ·` are the only permitted text ornaments.

## 8. Imagery

No photography ships with the system. Card/product thumbnails render as flat color blocks with condensed initials until real photography exists. When it arrives: photograph collectibles straight-on, high-contrast, on a flat color background — never a gradient or texture. Backgrounds throughout the app are solid ink or solid color blocks butted hard against each other; no patterns or photographic backgrounds.

## 9. Component inventory

Namespace: `window.DojoDesignSystem_55999a`. Each has `.jsx` + `.d.ts` + a usage prompt in the source design system.

### actions/Button
Plunk button — pressable, hard-edged.
```ts
variant?: 'primary' | 'inverse' | 'outline';  // primary = Dojo Gold, inverse = white-on-dark flip, outline = hairline
kind?: 'elevated' | 'flat';   // elevated shows 3px hard edge; flat has none but still presses
size?: 'big' | 'medium' | 'small';
fullWidth?: boolean; disabled?: boolean;
showArrow?: boolean;   // trailing pointer arrow
icon?: string;         // leading icon url
pressed?: boolean;     // force collapsed state
children, onClick
```

### display/Text
Type-scale element.
```ts
variant?: 'hero'|'h1'|'h2'|'h3'|'h4'|'h5'|'body'|'bodyMedium'|'small'|'caps'|'capsLg'|'num'|'serif';
color?: string; as?: string; fontSize?: string; // fontSize mainly for 'num'
```

### display/Tag
Hard rectangular status tag, caps type, square corners.
```ts
type?: 'success'|'error'|'warning'|'accent'|'neutral';
subtle?: boolean;      // tinted pastel fill + strong text vs solid fill
noContainer?: boolean; // bare caps text, no box
```

### surfaces/ElevatedCard
Static color-block card on hard offset edges.
```ts
backgroundColor?: string; edgeBottom?: string; edgeRight?: string;
plunk?: 'sm'|'lg';   // 3px vs 6px
fullWidth?: boolean; bordered?: boolean; padding?: string;
```

### surfaces/BottomSheet
Slides up over a dimmed scrim, sharp corners, no blur.
```ts
open?: boolean; onClose?: () => void;
container?: boolean; // position:absolute inside a phone frame vs fixed
```

### forms/InputField
Caps label + bold borderless input on a hairline underline.
```ts
id?, label?, placeholder?, value?, onChange?, hasError?: boolean,
errorMessage?: string, // replaces label while hasError
disabled?: boolean; noUnderline?: boolean; type?: string;
```

### forms/SearchBar
Hairline search box; border snaps to strong stroke when active, cross icon clears.
```ts
placeholder?, onSearch?: (text)=>void, onSubmit?: (text)=>void
```

### forms/Checkbox
20px sharp box, presses into the surface, inverts fill when checked.
```ts
checked?, onChange?: (checked)=>void, disabled?
```

### forms/Radio
20px — the one round control. Hard inset press shadow.
```ts
checked?, onChange?, disabled?, name?
```

### forms/Toggle
Square-puck switch in a hard-bordered 40×22 track; on-state floods gold.
```ts
checked?, onChange?, disabled?
```

### forms/Dropdown
Hairline trigger — label + square-cap chevron. Pair with BottomSheet for the option list.
```ts
label?, strong?: boolean, // full-strength border + heading-color text
bare?: boolean,           // chevron only, no border
onClick?
```

### forms/Slider
Flat track, square gold thumb, collapsing hard shadow on drag.
```ts
min?, max?, step?, value?, onChange?
```

### feedback/Toast
Flat saturated banner. **The only 4px-radius element in the system.**
```ts
type?: 'success'|'warning'|'error'; heading?, description?, fullWidth?, icon?
```

### feedback/ScoreMeter
270° circular gauge, big condensed tabular number centered.
```ts
reading?, min?, max?,
type?: 'excellent'|'average'|'poor', // jade / gold / vermilion arc
label?: string, valueText?: string, // valueText overrides center text, e.g. formatted currency
size?: number, // px, default 160
```

### navigation/Header
Page header: Back row + 24px serif heading + muted description.
```ts
heading?, description?, color?,
serif?: boolean, // Marcellus heading vs condensed sans
onBackClick?, rightElement?
```

### navigation/Back
Back row — long square-cap arrow, optional 14px heading, right-slot element.
```ts
heading?, color?, rightElement?, onClick?
```

### icons/Icon
```ts
name: string; size?: number; color?: string; strokeWidth?: number;
```

## 10. Layout patterns observed in the reference app

- Mobile-first, dark by default.
- Hero portfolio value in `.t-hero` numerals atop a gold `ElevatedCard` (`plunk="lg"`), signed delta directly beneath in jade/vermilion with the triangle glyph.
- Section rhythm: `.t-caps` label → content block → next `.t-caps` label, ~26–30px gaps.
- Bottom tab bar for primary nav (home / portfolio / scan / floor / profile), `Icon` glyphs at rest, gold fill on active.
- Cards for market movers / holdings: `ElevatedCard` with `plunk="sm"`, thumbnail as flat color block with condensed initials, name + ticker-style subtext, signed delta tag on the trailing edge.

## 11. Hard rules — do not do

- No gradients, no blur/glassmorphism, no glow shadows.
- No rounded corners except Toast (4px) and Radio (circle).
- No emoji, anywhere.
- No spring/bounce/overshoot easing; nothing idles with ambient animation.
- Don't invent new accent colors — gold is the only signature accent; jade/vermilion/amber are semantic-only (gains/losses/warning), not decorative.
- Don't substitute a different display font for Archivo or use it un-condensed for headlines.
- Don't skip the caps-label / sentence-case pairing — it's the system's voice signature, not a stylistic option.

## 11b. Landing-page addendum (decided July 2026)

- **Accent split:** gold = identity & ceremony only (wordmark, Origin seal, `◆` ornaments, at most one headline word). Jade = the action color for all pre-register/CTA controls, in addition to its market-positive role.
- **Scarcity copy is static** ("limited to 500") — no live or simulated counters anywhere until a real backend feeds them.

## 12. Applying this in Claude Code

Recreate these patterns using your codebase's existing component library and conventions (React/Vue/SwiftUI/etc.) rather than copying any HTML/CSS verbatim from the source design system. Map the tokens above onto your app's theme layer (CSS variables, Tailwind config, or platform equivalent), then build components against Section 9's prop contracts. If you need pixel-reference mockups or the icon SVGs, ask for them to be exported from the source project.
