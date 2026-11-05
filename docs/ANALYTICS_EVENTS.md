# Analytics event taxonomy (PostHog)

Shared source of truth so web and any future mobile app never drift. Event names
are **snake_case, past tense**. The TypeScript union `AnalyticsEvent` in
`src/lib/analytics/track.ts` mirrors the **wired** list below; add a name there
only when its flow ships.

All call sites use `track(event, props?)` (never `posthog` directly). `track` is a
no-op until PostHog is initialized (consent + key), never throws, and strips
`email`, `password`, `otp`, `token` keys. Email lives only on the **person
profile** via `identify()` (done in `AnalyticsProvider` from the Better Auth
client session); it is never an event property. UTM source is captured
automatically by PostHog on `signup_completed`.

## Common property rules

| Property | Values | Notes |
|---|---|---|
| `game` | `pokemon` \| `one_piece` | from the catalog id (Bandai code = One Piece) |
| `language` | `jp` \| `en` | Pokémon only, from the existing `_ja-` externalId marker; **omitted when unknown** (One Piece, scanner "all") |
| `condition` | `raw` \| `graded` | with `grade` (e.g. `10`, `9.5`) when graded |
| `card_id` | catalog `externalId` | RULE 3: never the internal cuid |
| `value_usd` | number | real stored USD price (source of truth). Omitted when the card has no price |
| `value_inr` | number | `value_usd` x a REAL USD->INR rate. **Omitted entirely** (never 0 / guessed) when no rate is available |
| `currency` | `"USD"` | source currency, added automatically with `value_usd` |

`value_inr` needs the optional server env `EXCHANGE_RATE_API_KEY` (see
`docs/ANALYTICS_SETUP.md`). `GET /api/fx/usd-inr` returns `{ rate, asOf }`
(`null` when no provider key / provider down); the client fetches it once per
session. Until the operator sets a working FX provider key, events carry
`value_usd` + `currency` only.

## Wired events

### Auth and onboarding

| Event | Properties | Fired when |
|---|---|---|
| `signup_started` | `method` (`email`\|`google`) | email: signup form submit. google: emitted together with `signup_completed` for a brand-new Google account, because the Google button lives on `/login` and cannot tell new from returning at click time |
| `signup_completed` | `method` | first authenticated session after signup (email: after OTP verification; google: after OAuth return for an account created < 10 min ago). Conversion event |
| `onboarding_completed` | none | `/profile` setup submitted |
| `login_completed` | `method` | first session after an email login, or Google return for an older account |
| `password_reset_requested` | none | forgot-password request accepted |

`signup_completed` / `login_completed` use a sessionStorage "auth intent" set by
the auth pages and consumed once by `AnalyticsProvider` when the session appears.
Verifying the email in a different browser/tab session means no completion event
(the intent is per tab).

### Activation

| Event | Properties | Fired when |
|---|---|---|
| `first_card_added` | `game`, `language?` | the add POST succeeded and the **server** saw zero prior collection rows for the user (`firstCard: true` in the POST response) |
| `portfolio_viewed` | `item_count`, `value_usd`, `value_inr?` | once per `/portfolio` mount after the collection loads (`item_count` = active cards incl. quantity) |

### Portfolio

| Event | Properties | Fired when |
|---|---|---|
| `card_added` | `card_id`, `game`, `language?`, `condition`, `grade?`, `quantity`, `value_usd?`, `value_inr?` | after the add POST succeeds (Add sheet, multi-select add, `/collection/add`). `value_usd` = unit price x quantity |
| `card_removed` | same as `card_added` | per row the server really deleted (portfolio bulk delete) |
| `portfolio_chart_viewed` | `range` (`1W`\|`1M`\|`3M`\|`1Y`\|`ALL`) | dashboard chart shown / range changed. App ids map `7D->1W`, `1M`, `3M`, `MAX->ALL`; the app's `1D` and `6M` have no taxonomy equivalent and send nothing |

### Search and discovery

| Event | Properties | Fired when |
|---|---|---|
| `search_performed` | `query` (<=100 chars), `game`, `results_count` | once per distinct text query+filters when the first result page resolves. `results_count` is the first page, so `0` = zero-result search |
| `card_viewed` | `card_id`, `set?`, `game`, `language?` | card detail page opened (once per card id) |
| `filter_applied` | `filter_type` (`set`, `rarity`, `graded`, `minPrice`, `maxPrice`, `hasPrice`, `language`, `sort`), `game` | a filter/sort is set to a new non-empty value (clearing is not tracked) |

### Wishlist

| Event | Properties | Fired when |
|---|---|---|
| `wishlist_added` | `card_id`, `game` | Want-to-Buy add accepted by the server (`useWantToBuy`, card popup) |

### Scanner

| Event | Properties | Fired when |
|---|---|---|
| `scan_started` | `game`, `language?` | a frame passes the quality gate and goes to recognition |
| `scan_succeeded` | `game`, `language?`, `candidate_count` | a candidate met the confidence threshold |
| `scan_failed` | `game`, `language?`, `reason` (`not_recognized`\|`error`) | no confident match, or the recognition threw |

Each `scan_started` is followed by exactly one `scan_succeeded` or `scan_failed`.

## Where to see them in-app

**Admin -> Analytics** (`/admin/analytics`) shows these events via the PostHog
Query API (see ANALYTICS_SETUP.md §7b) — a manager-oriented, read-only summary
with per-feature DETAIL (who / when / which card / value / context), not just
counts:

- **Recent activity** feed: the latest ~100 business events (every named event
  above + `$exception`; autocapture/pageview/web-vitals noise excluded), with
  the acting user's email, a friendly action label, the one salient prop, and
  value.
- **Search & discovery**: top terms, top zero-result searches (unmet demand),
  most-viewed cards, filter breakdown.
- **Portfolio**: most-added cards (qty + value), removals, raw-vs-graded,
  per-game, chart-range popularity.
- **Wishlist**: most-wishlisted cards, per-game.
- **Scanner**: started/succeeded/failed + success rate + failure reasons.
- **Auth & activation**: signups/logins by method, onboarding, resets, funnel.
- **Engagement & quality**: `$exception` count + recent errors, daily trend.

**Drill-down (in-app):** every overview COUNT CARD is clickable — it re-loads
the Recent-activity feed scoped to just the rows behind that number (Logins →
`login_completed`, Cards added → `card_added`, Searches → `search_performed`,
Zero-result → `search_performed`+`results_count=0`, Wishlist adds →
`wishlist_added`, Scans, Signups → `signup_completed`, Errors → `$exception`)
via the `event` filter param (FIXED allowlist + `zero_result` pseudo + `$exception`,
mapped to a constant HogQL predicate, never free text), with an active-filter
chip + "Show all" and a heading that reflects the filter. Unique Visitors drills
into the DISTINCT persons behind it (`view=persons`): identified by email +
an honest "anonymous (N)" remainder, never a fabricated identity.

The SAME feed reveal extends to the per-feature DETAIL label rows: clicking a
row in Top search terms, Top zero-result searches, Filters applied, Scanner
failure reasons, or Signups/Logins by method re-loads the Recent-activity feed
scoped to the events behind that row (who + when) via the `dimension`+`value`
params. `dimension` is a FIXED allowlist (`search_term`, `zero_result_term`,
`filter_type`, `scan_reason`, `signup_method`, `login_method`) → a constant
HogQL predicate; the row's `value` is the ONLY dynamic part and is bound via a
`{value}` placeholder (never interpolated), with categorical dimensions
(`filter_type`/`scan_reason`/`*_method`) additionally allowlisted against their
fixed enums (double-guard). Only ONE reveal shows at a time. The card lists
(most-added/-viewed/-wishlisted) keep the aggregate card popover; pure
ratio/by-game/chart-range/funnel/daily rows stay static (no honest per-person
drill). Everywhere a
`card_id` appears (feed Detail cell + most-added/-viewed/-wishlisted lists +
the card popover header) the human-readable card NAME leads (catalog
`externalId`→`Card.name`, resolved server-side in one batched Prisma query; raw
id kept as tooltip/secondary, unknown → raw id). The feed's User cell links to
`/admin/users/[id]` (email→user-id resolved server-side; anonymous/deleted →
no link), and that user-detail page shows the user's REAL recent per-user
behaviour (`getUserActivity`, this same taxonomy, filtered to the person via a
HogQL `{email}` placeholder) merged with DB account facts — honest fallback to
facts-only when PostHog is unavailable. Clicking a `card_id` opens a popover
with that card's viewed/added/wishlisted aggregate over the selected
range+environment (`getCardActivity`, `{card_id}` placeholder). Session replay
and ad-hoc chart building stay in PostHog (the "Open in PostHog" link), by design.

### Privacy — email in the admin feed

Showing the acting user's email in the admin Recent-activity feed is acceptable:
the page is admin-only and OTP-gated. The email is fetched **server-side via the
PostHog person join** (`person.properties.email` in the HogQL query) — it is
**NEVER** read from event properties, because `track()` strips `email` from
props and email lives only on the person profile via `identify()` (the rule
above). A person with no profile email renders as "anonymous". No raw event ever
carries an email.

## BACKLOG (not built, not instrumented)

These features do not exist in the codebase. **Wire when the flow ships**, and no
sooner. Do not add them to the `AnalyticsEvent` union early.

- Trusted stores: `store_viewed`, `listing_viewed`, `bid_placed`, `ask_set`,
  `offer_made`, `purchase_completed` (the GMV revenue event)
- Trading floor: `wtb_posted`, `wts_posted`, `offer_sent`, `offer_accepted`,
  `trade_completed`
- Events near you: `event_viewed`, `event_rsvp`
- Price triggers: `trigger_created`, `trigger_hit` (server-side),
  `trigger_notification_opened`
- CGC submissions: `cgc_submission_*` (started / submitted / status_checked), only
  if the CGC flow gets built

Money events in these families must follow the same `value_usd` + `value_inr` +
`currency` rule above.
