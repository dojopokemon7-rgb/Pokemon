#!/usr/bin/env node
/**
 * M-1 verification: does Caddy really reject oversized bodies on
 * /api/cards/recognize WITHOUT forwarding them to the upstream?
 *
 * How: reads the REAL repo Caddyfile, extracts the `@recognize` matcher and
 * `request_body` block from it (so the directive under test is the shipped one,
 * not a copy), wraps them in a minimal `:80` site that reverse-proxies to a stub
 * upstream on the host, runs the SAME image the project uses (docker-compose.yml
 * caddy service: caddy:2-alpine), fires real HTTP requests, and asserts.
 *
 * Usage: node scripts/verify-caddy-body-limit.mjs        (needs Docker running)
 * Touches nothing but a throwaway container + temp dir. No prod config.
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = "caddy:2-alpine";
const NAME = "dojo-caddy-bodylimit-test";
const CADDY_PORT = 18089;
const UPSTREAM_PORT = 18090;
const MB = 1_000_000;

const caddyfile = readFileSync(new URL("../Caddyfile", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const m = caddyfile.match(/^\s*@recognize path [^\n]+\n\s*request_body @recognize \{[^}]*\}[\s\S]*?request_body @recognize_anon \{[^}]*\}/m);
if (!m) throw new Error("Could not find @recognize/@recognize_anon request_body in the repo Caddyfile");
const directive = m[0];
const limitMatch = directive.match(/max_size\s+(\d+)MB/);
const anonMatch = directive.match(/max_size\s+(\d+)KB/);
if (!limitMatch) throw new Error("max_size NNMB not found in directive");
const LIMIT = Number(limitMatch[1]) * MB;
const ANON_LIMIT = Number(anonMatch[1]) * 1000;
const COOKIE = 'better-auth.session_token=abc.def';
const APP_CAP = Math.ceil((20 * 1024 * 1024 * 4) / 3) + 1024 * 1024; // route.ts MAX_REQUEST_BYTES
console.log(`directive under test:\n${directive}\nCaddy limit=${LIMIT} B, app MAX_REQUEST_BYTES=${APP_CAP} B`);

const sh = (a) => spawnSync("docker", a, { encoding: "utf8" });
if (sh(["info"]).status !== 0) throw new Error("Docker daemon not reachable");

const dir = mkdtempSync(join(tmpdir(), "caddy-bl-"));
writeFileSync(
  join(dir, "Caddyfile"),
  `{\n  admin off\n  auto_https off\n}\n:80 {\n${directive}\n  reverse_proxy host.docker.internal:${UPSTREAM_PORT}\n}\n`
);

// Stub upstream: records every request path + bytes received.
const seen = [];
const upstream = http.createServer((req, res) => {
  let n = 0;
  req.on("data", (c) => (n += c.length));
  req.on("error", () => {});
  // One record per request, written on close: complete=false means the body was
  // cut off mid-stream (Caddy aborted the upstream request).
  req.on("close", () => seen.push({ path: req.url, bytes: n, complete: req.complete }));
  req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"stub":true}'));
});

function post(path, size, { chunked = false, cookie = true } = {}) {
  return new Promise((resolve) => {
    const headers = { "content-type": "application/json" };
    if (cookie) headers.cookie = COOKIE;
    if (!chunked) headers["content-length"] = String(size);
    const r = http.request({ host: "127.0.0.1", port: CADDY_PORT, path, method: "POST", headers }, (res) => {
      res.resume();
      // settle: let the upstream's own "close" record land before we assert
      res.on("end", () => setTimeout(() => resolve({ status: res.statusCode }), 300));
    });
    r.on("error", (e) => resolve({ status: `ERR ${e.code}` }));
    const chunk = Buffer.alloc(256 * 1024, 0x41);
    let sent = 0;
    (function write() {
      while (sent < size) {
        const buf = chunk.subarray(0, Math.min(chunk.length, size - sent));
        sent += buf.length;
        if (!r.write(buf)) return void r.once("drain", write);
      }
      r.end();
    })();
  });
}

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label} ${extra}`);
  if (!cond) failures++;
};

await new Promise((r) => upstream.listen(UPSTREAM_PORT, "0.0.0.0", r));
sh(["rm", "-f", NAME]);
try {
  const up = sh([
    "run", "-d", "--name", NAME, "--add-host", "host.docker.internal:host-gateway",
    "-p", `127.0.0.1:${CADDY_PORT}:80`, "-v", `${join(dir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`, IMAGE,
  ]);
  if (up.status !== 0) throw new Error(up.stderr);
  console.log("caddy:", sh(["exec", NAME, "caddy", "version"]).stdout.trim());
  for (let i = 0; i < 50; i++) {
    const ok = await post("/healthz-probe", 10);
    if (typeof ok.status === "number") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const hits = (p) => seen.filter((s) => s.path === p);

  const R = "/api/cards/recognize";
  const run = async (size, opts) => {
    seen.length = 0;
    const r = await post(R, size, opts);
    return { status: r.status, up: hits(R) };
  };
  const complete = (up) => up.some((x) => x.complete);

  // --- session-cookie callers: 30MB ceiling ---
  let x = await run(LIMIT + 1_000_000);
  check("cookie, 31MB (Content-Length) -> 413", x.status === 413, `got ${x.status}`);
  check("  ...upstream never gets a COMPLETE body; cut at <= limit", !complete(x.up) && x.up.every((u) => u.bytes <= LIMIT), JSON.stringify(x.up));
  x = await run(LIMIT + 1_000_000, { chunked: true });
  check("cookie, 31MB CHUNKED (no Content-Length) -> 413, cut at <= limit", x.status === 413 && !complete(x.up) && x.up.every((u) => u.bytes <= LIMIT), `got ${x.status} ${JSON.stringify(x.up)}`);
  x = await run(2 * MB);
  check("cookie, typical scan 2MB -> forwarded, 200", x.status === 200 && x.up[0]?.bytes === 2 * MB, `got ${x.status}`);
  x = await run(APP_CAP);
  check("cookie, legit max body (== app MAX_REQUEST_BYTES) -> forwarded, 200", x.status === 200 && x.up[0]?.bytes === APP_CAP, `got ${x.status}`);
  x = await run(LIMIT);
  check("cookie, exactly the Caddy limit -> forwarded (app 413 is the precise guard)", x.status === 200, `got ${x.status}`);

  // --- anonymous callers (no session cookie): 64KB ceiling ---
  x = await run(5 * MB, { cookie: false });
  check("NO cookie, 5MB -> 413 and upstream never sees a complete body (<= 64KB cut)", x.status === 413 && !complete(x.up) && x.up.every((u) => u.bytes <= ANON_LIMIT), `got ${x.status} ${JSON.stringify(x.up)}`);
  x = await run(30_000_000 - 1000, { cookie: false, chunked: true });
  check("NO cookie, ~30MB chunked (the M-1 attack) -> 413, upstream sees <= 64KB", x.status === 413 && x.up.every((u) => u.bytes <= ANON_LIMIT), `got ${x.status} ${JSON.stringify(x.up)}`);
  x = await run(20_000, { cookie: false });
  check("NO cookie, 20KB anonymous text body -> forwarded, 200", x.status === 200 && x.up[0]?.bytes === 20_000, `got ${x.status}`);

  // --- other routes untouched ---
  seen.length = 0;
  const o = await post("/api/other", LIMIT + 1_000_000, { cookie: false });
  check("other route, 31MB, no cookie -> unaffected (forwarded)", o.status === 200 && hits("/api/other")[0]?.bytes === LIMIT + 1_000_000, `got ${o.status}`);
} finally {
  sh(["rm", "-f", NAME]);
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
