// k6 load test — hot READ paths of the Dojo TCG PWA.
//
// Option-1 target: local standalone build + local Postgres (tcg_localdb :5433)
// + local Redis (tcg_redis :6379), Scrydex credits OFF. This measures the
// APP's own throughput (routing, query shape, cache behavior) — NOT Supabase
// pool limits or network latency (those need a prod-env rerun after deploy).
//
// Run via Docker (no local k6 install):
//   docker run --rm -i --add-host=host.docker.internal:host-gateway \
//     -e BASE=http://host.docker.internal:3002 \
//     grafana/k6 run - < scripts/loadtest/read-paths.js
//
// Staged ramp: 50 -> 200 -> 500 concurrent VUs. Reports p95/p99 latency,
// throughput, and error rate per the thresholds below.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.BASE || "http://host.docker.internal:3002";

// Real externalIds sampled from the local catalog (50k cards) so card-detail
// paths hit real rows, not 404s.
const CARD_IDS = ["xy_ja-55", "xy10-37", "svom_ja-8", "swsh12a_ja-76", "hgss3-27", "xy3-71", "sm10-17", "sv1v_ja-42"];
// Realistic free-text searches (common Pokemon names + a set-ish term).
const QUERIES = ["charizard", "pikachu", "mewtwo", "umbreon", "rayquaza", "eevee", "gengar", "lucario"];

const errors = new Rate("errors");

export const options = {
  // Ramp through three load stages, each held for 1m, with ramp transitions.
  stages: [
    { duration: "30s", target: 50 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 200 },
    { duration: "1m", target: 200 },
    { duration: "30s", target: 500 },
    { duration: "1m", target: 500 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<800", "p(99)<2000"], // informational targets
    errors: ["rate<0.05"],
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  // Weight the mix toward what 1000 real users actually hit: mostly search +
  // trending + card detail, with an occasional health ping.
  const roll = Math.random();
  let res;

  if (roll < 0.4) {
    // Search (the heaviest query path — trigram + filters + pagination).
    // NOTE: the API game enum is lowercase ("pokemon"/"onepiece"), distinct
    // from the DB enum (POKEMON/ONE_PIECE) — the route maps between them.
    const q = pick(QUERIES);
    res = http.get(`${BASE}/api/cards/search?game=pokemon&query=${q}&limit=24`, {
      tags: { name: "search" },
    });
  } else if (roll < 0.65) {
    // Trending feed (cached 120s — exercises the Redis cache hit path).
    res = http.get(`${BASE}/api/cards/trending?game=pokemon&sort=trending`, {
      tags: { name: "trending" },
    });
  } else if (roll < 0.9) {
    // Card detail data (prices + history for a real card).
    const id = pick(CARD_IDS);
    res = http.get(`${BASE}/api/cards/${id}/prices`, { tags: { name: "card-prices" } });
  } else {
    // Health (cheapest; readiness check).
    res = http.get(`${BASE}/api/health`, { tags: { name: "health" } });
  }

  const ok = check(res, {
    "status is 2xx/3xx": (r) => r.status >= 200 && r.status < 400,
  });
  errors.add(!ok);

  // Small think-time so VUs model users, not a tight hammer loop.
  sleep(Math.random() * 0.5 + 0.2);
}
