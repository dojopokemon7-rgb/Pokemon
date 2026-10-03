# DRAFT — Scrydex support request (NOT SENT)

> Prepared per owner instruction. Do NOT send without owner review/approval.
> Recipient: Scrydex support (contact per https://scrydex.com/terms §18).
> Purpose: obtain WRITTEN commercial-use authorization + image-retention clarity
> before any commercial launch or bulk ingestion (production gates — see
> docs/SCRYDEX_AUDIT.md).

---

Subject: Written commercial-use authorization + Vision image-retention clarification

Hello Scrydex team,

We are building a commercial Pokémon/One Piece collection-tracking app and are
migrating our data layer onto the Scrydex API (team id on file). Before we launch
commercially or ingest at scale, we want written confirmation on a few points your
Terms of Service (§4, §8) make conditional on prior authorization.

1. End-user display. May we display Scrydex-sourced card metadata, current prices,
   price history, PSA population, and sold-listing records to our end users within a
   paid commercial app?

2. Database storage / caching. May we store and cache Scrydex API responses in our
   own database (our system of record) and a short-TTL cache, refreshing on a ~24h
   cadence, rather than calling live on every view? (Your Rate Limits page encourages
   caching; we want this confirmed as compatible with §4.)

3. Bulk ingestion. May we run a periodic bulk/catalog + price-history ingestion to
   keep our catalog current? We want to confirm this is not considered "wholesale /
   substitute-backend" use under §4, and to understand any volume or scheduling
   constraints under the Fair AI Usage policy (§7).

4. Post-cancellation retention / use. If we stop our subscription, may we retain and
   continue to display data already ingested while subscribed, or must some/all of it
   be purged? Under what conditions?

5. Vision image retention. For images sent to POST /vision/v1/cards/identify: do you
   store or retain the uploaded image after identification, and for how long? Our app
   discards the image immediately after scanning on our side; we need to accurately
   describe YOUR handling to our users for privacy disclosure. (We understand §8
   grants a processing license; we are asking specifically about retention duration.)

A short written confirmation (email is fine) on each point would let us proceed.
Please also point us to any commercial-tier or data-licensing terms we should sign.

Thank you,
[Owner name / company]
[Account / team id reference — do NOT paste the API key]
