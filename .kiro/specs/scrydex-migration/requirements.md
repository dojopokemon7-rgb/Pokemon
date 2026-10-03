# Requirements Document

## Introduction

This feature migrates the Dojo TCG Collection PWA toward Scrydex as the authoritative source for Pokémon card catalog data and price history, while hardening four product areas that depend on that data: the camera scanner, portfolio sales/accounting, search/card-detail, and the dashboard/collections/onboarding surfaces. The work is **brownfield**: a partial Scrydex integration already exists (`scrydex.service.ts`, `scrydex-pricing.service.ts`, `Card.scrydexId`, the `PricingHistory`/`CurrentPrice`/`SyncLog` models, and a `DataSource` enum of `TCGDEX | POKEWALLET | SCRYDEX`), a PokéWallet service exists, the scanner uses Google Vision, `UserCollection` already carries `isSold`/`soldPrice`/`soldAt`/`purchasePrice` scaffolding, and onboarding completion is not yet persisted.

The migration is delivered as **one combined spec across five functional areas plus a cross-cutting audit/safety area**. The first phase is a **read-only audit (Checkpoint A)** that spans all five areas and surfaces concrete Scrydex endpoint, field, identifier, rate-limit, and credit-cost facts **before** any implementation. Implementation then proceeds in dependency-ordered, individually reviewable phases, each shipping documentation, tests, and verification. Deliberately **removed** in this migration: the derived `scrydex-trend` backfill that fabricated/interpolated history — replaced by fetching Scrydex's real RAW/PSA/BGS history series with honest gaps where history is genuinely missing.

This document specifies **what** the system must do. Implementation detail (how) is deferred to the design document, except where repository invariants are themselves acceptance criteria (auth discipline, validation boundaries, ownership scoping, cache optionality, identifier discipline, graceful public-route degradation, design tokens, and the verification gate).

## Glossary

- **Dojo_System**: The Dojo TCG Collection PWA as a whole (Next.js App Router server + client, Prisma/Postgres, Redis cache).
- **Scrydex_Service**: The server-side module (`scrydex.service.ts` and `scrydex-pricing.service.ts`) that fetches catalog and pricing data from the Scrydex API.
- **Scrydex_API**: The external Scrydex HTTP API that provides card catalog data, current prices, and RAW/PSA/BGS price-history series.
- **PokeWallet_Service**: The existing PokéWallet integration, constrained by this feature to current-price-only fallback.
- **Audit_Report**: The read-only Checkpoint A deliverable documenting Scrydex endpoints, fields, identifiers, rate limits, and credit-cost estimates across all five areas.
- **Scanner_Service**: The server-side card-recognition path that today uses Google Vision to identify a card from an uploaded photo.
- **Scan_Allowance**: The per-user lifetime count of successful card identifications permitted, bounded by a configurable limit.
- **Scan_Limit**: The configurable maximum number of successful identifications a user may perform (default 10, overridable per paid tier via config constant/environment variable).
- **Portfolio_Service**: The server-side logic that computes portfolio holdings, sales, and profit-and-loss (P&L).
- **Cost_Basis**: The purchase price recorded for a held card, used to compute P&L.
- **Unresolved_Cost_Basis**: A Cost_Basis state where no purchase price could be determined at add time, marked with a null value and an attempt timestamp, pending lazy resolution.
- **Card_Internal_Id**: `Card.id`, the internal cuid used for React keys, detail links, and admin PATCH.
- **Card_External_Id**: `Card.externalId`, the catalog identifier (e.g. `base1-4`, `OP01-064`) used in search results, want-list `cardId`, history, reprice, and add-to-collection.
- **Scrydex_Id**: `Card.scrydexId`, the Scrydex-specific catalog identifier for a card.
- **Price_History_Series**: A time-ordered sequence of Scrydex-sourced prices for a card at a specific grade tier (RAW, PSA, or BGS).
- **FX_Service**: The server-side logic that converts a source-native current price to the user's profile display currency (USD or EUR).
- **Owner_Approval**: Explicit confirmation from the project owner, required before production migrations, bulk refreshes, or nontrivial paid credit consumption.
- **Verification_Gate**: The `npm run verify` pipeline (lint → unit → integration → chart-accuracy → e2e).

## Requirements

### Area 0 — Cross-Cutting Audit & Safety

### Requirement 1: Read-Only Scrydex Audit (Checkpoint A)

**User Story:** As the project owner, I want a read-only audit of Scrydex capabilities across all five areas before any code changes, so that I can see real endpoint, field, identifier, rate-limit, and credit-cost facts and approve implementation on evidence.

#### Acceptance Criteria

1. THE Scrydex_Service SHALL perform the Checkpoint A audit as the first phase of this feature, before any schema migration or write-path implementation.
2. WHILE performing the Checkpoint A audit, THE Scrydex_Service SHALL restrict all Scrydex_API interactions to read-only operations.
3. THE Audit_Report SHALL document, for each of the five functional areas, the Scrydex_API endpoints, response fields, card identifiers, rate limits, and estimated credit cost per operation.
4. THE Audit_Report SHALL identify the Scrydex_API fields that supply RAW, PSA, and BGS Price_History_Series and SHALL record where any of those series are unavailable.
5. WHERE a required capability is absent from the Scrydex_API, THE Audit_Report SHALL record the gap and the affected area.
6. THE Audit_Report SHALL be written to the repository documentation set as a reviewable artifact.

### Requirement 2: Phased, Reviewable Delivery (Checkpoint B)

**User Story:** As a reviewer, I want implementation delivered in dependency-ordered, individually reviewable phases, so that I can review, test, and verify each phase in isolation.

#### Acceptance Criteria

1. THE Dojo_System changes SHALL be organized into dependency-ordered phases where each phase depends only on the Audit_Report or an earlier phase.
2. WHEN a phase is submitted for review, THE phase SHALL include updated documentation, tests, and a passing Verification_Gate run.
3. WHEN a change alters behavior pinned to an F-number test, THE corresponding test SHALL be updated before the implementation change.
4. THE Dojo_System SHALL NOT bundle unrelated areas into a single reviewable phase.

### Requirement 3: Evidence-Based Reporting (Checkpoint C)

**User Story:** As the project owner, I want each completed phase reported with concrete evidence, so that I can confirm what changed without re-deriving it.

#### Acceptance Criteria

1. WHEN a phase completes, THE Dojo_System deliverable SHALL report the changed files, database migrations, commands run, Scrydex credits consumed, and any data gaps encountered.
2. WHEN a phase completes, THE deliverable SHALL include a manual QA checklist for the behavior changed in that phase.
3. IF a phase consumed Scrydex credits, THEN THE deliverable SHALL report the measured or estimated credit count.

### Requirement 4: Owner-Approval Safety Gate (Checkpoint D)

**User Story:** As the project owner, I want irreversible or costly operations gated behind my explicit approval, so that no production data or paid budget is touched without sign-off.

#### Acceptance Criteria

1. IF an operation is a production database migration, THEN THE Dojo_System SHALL stop and request Owner_Approval before executing the operation.
2. IF an operation is a bulk price or catalog refresh, THEN THE Dojo_System SHALL stop and request Owner_Approval before executing the operation.
3. IF an operation would consume nontrivial paid Scrydex credits, THEN THE Dojo_System SHALL stop and request Owner_Approval before executing the operation.
4. THE Dojo_System SHALL exclude Scrydex and all other secrets from logs, Audit_Report content, test output, and committed files.

### Requirement 5: Repository Invariants Across All Changes

**User Story:** As a maintainer, I want every change in this feature to honor the established architectural invariants, so that the migration does not erode the system's design guarantees.

#### Acceptance Criteria

1. THE Dojo_System SHALL import Better Auth server configuration only in server modules and Better Auth client configuration only in client modules.
2. THE Dojo_System SHALL validate every external payload, cache-read payload, and request body with a Zod schema at the boundary.
3. WHEN performing a user-scoped mutation, THE Dojo_System SHALL scope the Prisma query with `where: { id, userId }` so that a foreign identifier yields a 404.
4. IF a Redis read or write fails, THEN THE Dojo_System SHALL fall through to live data and complete the request.
5. THE Dojo_System SHALL preserve the distinction between Card_Internal_Id, Card_External_Id, and Scrydex_Id in every data path that references a card.
6. WHEN a public card or pricing route cannot return data, THE Dojo_System SHALL respond with HTTP 200 and a fallback payload rather than a 5xx status.
7. THE Dojo_System SHALL render all colors from the `--color-dojo-*` design tokens and SHALL NOT introduce non-token colors or non-zero corner radii.
8. WHEN the feature is reported complete, THE Verification_Gate SHALL pass.

### Area 1 — Scrydex Data & Pricing

### Requirement 6: Scrydex as Catalog and Price-History Source

**User Story:** As a collector, I want card data and price history sourced from Scrydex, so that catalog and pricing information reflect a real, authoritative source.

#### Acceptance Criteria

1. THE Scrydex_Service SHALL fetch card catalog and current-price data from the Scrydex_API using the identifiers and endpoints recorded in the Audit_Report.
2. THE Scrydex_Service SHALL validate each Scrydex_API card payload with a Zod schema and SHALL drop any card that fails validation.
3. IF a Scrydex_API response contains zero valid cards, THEN THE Scrydex_Service SHALL raise a no-results condition so the fallback chain advances without tripping the circuit breaker.
4. THE Dojo_System SHALL persist the Scrydex_Id on each card alongside Card_Internal_Id and Card_External_Id, keeping all three identifiers distinct.
5. WHERE a Scrydex-sourced price is cached in Redis, THE Scrydex_Service SHALL re-validate the cached payload with a Zod schema on read.
6. THE Scrydex_Service SHALL address Scrydex endpoints using the card id returned by the Scrydex card response, and SHALL NOT assume that id equals Card_External_Id or Card_Internal_Id. WHERE the mapping between the Scrydex-returned id and Card_External_Id/Scrydex_Id is not yet empirically verified, THE Dojo_System SHALL NOT hardcode a mapping and SHALL treat it as an unresolved verification item (Audit_Report L0).

### Requirement 7: Real RAW/PSA/BGS Price History with Honest Gaps

**User Story:** As a collector, I want real RAW, PSA, and BGS price history, so that charts reflect actual market data and never fabricated points.

#### Acceptance Criteria

1. THE Scrydex_Service SHALL fetch Price_History_Series from the documented Pokémon price-history endpoint `GET /pokemon/v1/cards/{id}/price_history` (using the Scrydex-returned card id — see Requirement 6a), applying the documented filters (`days`/`start_date`/`end_date`/`variant`/`condition`/`company`/`grade`) as needed.
2. THE Dojo_System SHALL remove the derived `scrydex-trend` backfill that produced fabricated or interpolated history, and SHALL NOT rely on the obsolete "no history endpoint / accumulate only from future snapshots" assumption.
3. IF a Price_History_Series has no data for a period, THEN THE Dojo_System SHALL represent that period as a gap and SHALL NOT synthesize, interpolate, or invent price points.
4. WHEN rendering a price-history chart, THE Dojo_System SHALL display only real Scrydex-sourced points and gaps.
5. THE RAW Price_History_Series SHALL be charted at Near Mint (`condition=NM`, `type=raw`); other raw conditions SHALL be shown as current prices beneath the chart, not as history series.
6. WHERE the Scrydex price-history RESPONSE does not carry identifiable `company`/`grade` labels on returned points, OR where a single unfiltered call does not yield separable RAW/PSA/BGS series, THE Dojo_System SHALL treat graded (PSA/BGS) history-series drawability as UNRESOLVED and SHALL NOT fabricate graded chart series. (See Audit_Report "History graded series" — unresolved pending L2.)

### Requirement 8: PokéWallet Constrained to Current-Price Fallback

**User Story:** As a maintainer, I want PokéWallet limited to current-price fallback only, so that it never becomes a source of fabricated history.

#### Acceptance Criteria

1. THE PokeWallet_Service SHALL supply only current-price data and SHALL NOT supply Price_History_Series.
2. WHEN Scrydex current-price data is unavailable for a card, THE Dojo_System SHALL use PokeWallet_Service current-price data as a fallback.
3. THE Dojo_System SHALL retain `SCRYDEX`, `POKEWALLET`, and `TCGDEX` as `DataSource` values and SHALL label each stored price with its originating DataSource.

### Requirement 9: Source-Native Charts with Current-Price FX Conversion

**User Story:** As a collector, I want charts shown in the source currency with current prices converted to my display currency, so that values are both accurate and readable in my preferred currency.

#### Acceptance Criteria

1. THE Dojo_System SHALL render Price_History_Series charts in the source-native currency of the data.
2. WHEN displaying a current price, THE FX_Service SHALL convert the source-native amount to the user's profile display currency of USD or EUR.
3. THE FX_Service SHALL apply currency conversion only to current prices and SHALL NOT convert historical Price_History_Series points.
4. THE Dojo_System SHALL document the FX rate provider and the conversion-failure behavior.
5. IF the FX_Service cannot obtain a conversion rate, THEN THE Dojo_System SHALL display the source-native current price and indicate that conversion is unavailable.

### Area 2 — Scanner

### Requirement 10: Server-Enforced Lifetime Scan Allowance

**User Story:** As the project owner, I want a server-enforced lifetime limit on successful scans, so that scan usage stays within a configurable, tier-aware budget.

#### Acceptance Criteria

1. THE Dojo_System SHALL store a per-user successful-identification counter in a `User` database column.
2. THE Dojo_System SHALL read the Scan_Limit from a configuration constant or environment variable with a default of 10 successful identifications.
3. WHERE a user belongs to a paid tier, THE Dojo_System SHALL apply the Scan_Limit configured for that tier.
4. WHEN a scan successfully identifies a card, THE Scanner_Service SHALL increment the user's Scan_Allowance counter within a transaction or reservation that prevents concurrent scans from exceeding the Scan_Limit.
5. IF a scan does not successfully identify a card, THEN THE Scanner_Service SHALL NOT increment the Scan_Allowance counter.
6. IF a user's Scan_Allowance has reached the Scan_Limit, THEN THE Scanner_Service SHALL reject further scan attempts and return a limit-reached response.
7. WHEN enforcing the Scan_Allowance, THE Scanner_Service SHALL identify the user from the Better Auth server session rather than from client-supplied values.

### Requirement 11: Scan Upload Validation and Image Disposal

**User Story:** As a user, I want my scan photo validated and then discarded, so that uploads are safe and my image is not retained.

#### Acceptance Criteria

1. WHEN a scan image is uploaded, THE Scanner_Service SHALL reject any upload larger than 20 megabytes.
2. WHEN a scan image is uploaded, THE Scanner_Service SHALL validate the image MIME type on the server and SHALL reject unsupported types.
3. WHEN a scan completes, THE Scanner_Service SHALL discard the uploaded image rather than persist it.
4. IF upload validation fails, THEN THE Scanner_Service SHALL reject the upload and SHALL NOT increment the Scan_Allowance counter.

### Area 3 — Portfolio Sales & Accounting

### Requirement 12: Lazy-Resolved Cost Basis on Add

**User Story:** As a collector, I want to add a card even when its purchase price is unknown, so that adding is never blocked and no invented cost is stored.

#### Acceptance Criteria

1. WHEN a card is added and no Cost_Basis can be determined, THE Portfolio_Service SHALL add the card and mark its Cost_Basis as Unresolved_Cost_Basis with a null value and an attempt timestamp.
2. THE Portfolio_Service SHALL NOT block an add operation because a Cost_Basis is unavailable.
3. THE Portfolio_Service SHALL NOT store a zero or invented value for an Unresolved_Cost_Basis.
4. WHEN the next successful price fetch occurs for a card with an Unresolved_Cost_Basis, THE Portfolio_Service SHALL resolve and persist the Cost_Basis.
5. WHILE a Cost_Basis is unresolved, THE Portfolio_Service SHALL report the card's profit-and-loss as "unresolved".
6. WHEN resolving an Unresolved_Cost_Basis, THE Portfolio_Service SHALL scope the Prisma update with `where: { id, userId }`.

### Requirement 13: Sales Recording and Realized P&L

**User Story:** As a collector, I want to record a sale with its price and date, so that my realized profit-and-loss is tracked accurately.

#### Acceptance Criteria

1. WHEN a user records a sale, THE Portfolio_Service SHALL set `isSold`, `soldPrice`, and `soldAt` on the user's `UserCollection` row.
2. WHEN a user records a sale, THE Portfolio_Service SHALL validate the sale payload with a Zod schema at the boundary.
3. WHEN computing realized profit-and-loss for a sold card, THE Portfolio_Service SHALL use `soldPrice` and the recorded `purchasePrice`.
4. IF a sold card has an Unresolved_Cost_Basis, THEN THE Portfolio_Service SHALL report its realized profit-and-loss as "unresolved".
5. WHEN recording a sale, THE Portfolio_Service SHALL scope the Prisma mutation with `where: { id, userId }`.

### Area 4 — Search & Card Detail

### Requirement 14: Scrydex-Backed Search and Card Detail

**User Story:** As a collector, I want search and card-detail views backed by Scrydex data, so that the information I browse matches the authoritative source.

#### Acceptance Criteria

1. WHEN a user searches the catalog, THE Dojo_System SHALL return results sourced from Scrydex using Card_External_Id as the result identifier.
2. WHEN a user opens a card-detail view, THE Dojo_System SHALL display the card's Scrydex-sourced current price and RAW/PSA/BGS Price_History_Series.
3. IF the search or card-detail data source is unavailable, THEN THE Dojo_System SHALL respond with HTTP 200 and a fallback payload.
4. WHEN paginating search or trending results, THE Dojo_System SHALL use offset pagination with a numeric `nextCursor`.
5. WHEN a card has an Unresolved_Cost_Basis in the user's collection, THE card-detail view SHALL indicate the unresolved state rather than show a zero cost.

### Requirement 15: Manual-Only Population Refresh

**User Story:** As a collector, I want population data refreshed only when I ask, so that costly population lookups never happen automatically — and I want it shown only where Scrydex actually documents coverage.

#### Acceptance Criteria

1. THE Dojo_System SHALL treat PSA English population as CONDITIONALLY supported: it SHALL request population only with `include=pop_reports` and SHALL present it only where card-level data is actually returned.
2. THE Dojo_System SHALL treat BGS population as UNAVAILABLE under current documented Scrydex coverage (coverage table lists PSA English only), SHALL NOT request or imply BGS population, and SHALL render the fallback state for it.
3. THE Dojo_System SHALL refresh population data only in response to an explicit manual action.
4. THE Dojo_System SHALL NOT refresh population data automatically on page load, search, or scheduled sync.
5. WHERE population data has not been refreshed OR is outside documented coverage, THE card-detail view SHALL render a fallback state rather than a fabricated population value.
6. THE Dojo_System SHALL keep Vision slab grade-detection (which can read PSA/BGS/CGC/TAG off an image) distinct from population coverage, and SHALL NOT infer population availability from Vision grading support.

### Area 5 — Dashboard, Collections & Onboarding

### Requirement 16: Real Dashboard and Collection Values

**User Story:** As a collector, I want dashboard and collection totals computed from real stored prices, so that the figures reflect actual data and unresolved items are visible.

#### Acceptance Criteria

1. WHEN rendering dashboard and collection totals, THE Dojo_System SHALL compute values from Scrydex-sourced stored prices.
2. THE Dojo_System SHALL NOT include fabricated or synthetic price points in dashboard or collection totals.
3. WHILE a card in a collection has an Unresolved_Cost_Basis, THE Dojo_System SHALL present that card's profit-and-loss contribution as "unresolved".
4. WHEN querying a user's collections, THE Dojo_System SHALL scope Prisma queries to the authenticated user.

### Requirement 17: Persisted Onboarding Completion

**User Story:** As a returning user, I want my onboarding completion remembered, so that I am not re-prompted after finishing it once.

#### Acceptance Criteria

1. WHEN a user completes onboarding, THE Dojo_System SHALL persist the completion state to the database for that user.
2. WHEN an authenticated user who has completed onboarding loads the application, THE Dojo_System SHALL NOT re-prompt that user to complete onboarding.
3. WHEN reading or writing onboarding completion state, THE Dojo_System SHALL identify the user from the Better Auth server session.



