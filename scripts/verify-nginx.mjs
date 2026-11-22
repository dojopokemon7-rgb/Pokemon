#!/usr/bin/env node
/**
 * End-to-end proof that the REAL infra/nginx config (in the image pinned in
 * docker-compose.yml) reproduces what the Caddyfile did. Docs: docs/NGINX_CUTOVER.md,
 * Caddy behavior inventory: .agents/tasks/nginx/caddy-inventory.md.
 *
 * Rig: a throwaway user-defined docker network (so the real `resolver 127.0.0.11`
 * and the upstream names `app` / `app-staging` are exercised), two node stub
 * upstreams, the pinned nginx with the compose env/entrypoint/volume layout, and a
 * caddy:2-alpine for header parity. TLS uses a FRESHLY GENERATED self-signed cert in
 * a temp dir; infra/cloudflare-origin is never read. nginx is published on
 * 127.0.0.1:18443/18080 only, so it can never collide with a real proxy on 80/443.
 *
 * Usage: node scripts/verify-nginx.mjs      (needs Docker running; ~2-4 min)
 */
import http from "node:http";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const IMAGE = compose.match(/^\s*image:\s*(nginx:\S+)\s*$/m)?.[1];
if (!IMAGE) throw new Error("nginx image line not found in docker-compose.yml");
const NET = "dojo-nginx-verify-net";
const N = (s) => `dojo-nginx-verify-${s}`;
const C = { nginx: N("nginx"), nginxT: N("nginx-t"), app: N("app"), staging: N("app-staging"), caddy: N("caddy"), spacer: N("spacer") };
const HTTPS = 18443, HTTP = 18080, HTTPS_T = 18444, CADDY = 18081;
const PW = "dojo-staging-2026";
const AUTH = "Basic " + Buffer.from(`staging:${PW}`).toString("base64");
const PROD = "dojocollect.test", STG = "staging.dojocollect.test";
const MB = 1_000_000;
const sh = (a, o = {}) => spawnSync("docker", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (sh(["info"]).status !== 0) throw new Error("Docker daemon not reachable");

const rows = [];
const check = (label, cond, extra = "") => {
  rows.push({ label, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${label} ${cond ? "" : extra}`);
};

const dir = mkdtempSync(join(tmpdir(), "nginx-verify-"));
const cleanup = () => {
  for (const c of Object.values(C)) sh(["rm", "-f", c]);
  sh(["network", "rm", NET]);
};

// ---- stub upstream (runs inside node:22-alpine as `app` / `app-staging`) ----
writeFileSync(join(dir, "stub.js"), `
const http = require("http"), zlib = require("zlib");
const TAG = process.env.TAG; let seen = [];
const APP = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=63072000; includeSubDomains; preload" };
const text = "body{color:red}\\n".repeat(200);
http.createServer((req, res) => {
  let n = 0; req.on("data", (c) => (n += c.length)); req.on("error", () => {});
  req.on("close", () => seen.push({ url: req.url, bytes: n, complete: req.complete }));
  req.on("end", () => {
    const p = req.url.split("?")[0];
    if (p === "/slow") return setTimeout(() => res.writeHead(200, APP).end("slow-ok"), 4000);
    if (p === "/api/admin/grading-interest/export") {
      res.writeHead(200, { ...APP, "content-type": "text/csv" }); res.write("chunk1\\n");
      return setTimeout(() => res.end("chunk2\\n"), 1500);
    }
    if (p === "/css") return res.writeHead(200, { ...APP, "content-type": "text/css" }).end(text);
    if (p === "/small-css") return res.writeHead(200, { ...APP, "content-type": "text/css", "content-length": "6" }).end("a{b:c}");
    if (p === "/gz") return res.writeHead(200, { ...APP, "content-type": "text/css", "content-encoding": "gzip" }).end(zlib.gzipSync(text));
    if (p === "/cookie") return res.writeHead(302, { ...APP, location: "https://dojocollect.test/login", "set-cookie": "a=b; Secure; HttpOnly; SameSite=Lax" }).end();
    if (p === "/hdrs") return res.writeHead(200, { ...APP, "content-type": "application/octet-stream" }).end("x");
    res.writeHead(200, { ...APP, "content-type": "application/json" });
    res.end(JSON.stringify({ tag: TAG, method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, bodyBytes: n, complete: req.complete }));
  });
}).listen(3000);
http.createServer((q, s) => { if (q.url === "/__clear") seen = []; s.end(JSON.stringify(seen)); }).listen(3001, "127.0.0.1");
`);

// ---- client helper: HTTPS (SNI + Host) or plain HTTP, optional body of N bytes ----
function req({ port = HTTPS, tls = true, host = PROD, sni = host, path = "/echo", method, size = 0, chunked = false, headers = {}, auth = false }) {
  return new Promise((resolve) => {
    const h = { host, ...headers };
    if (auth) h.authorization = AUTH;
    if (size) h["content-type"] = "application/json";
    if (size && !chunked) h["content-length"] = String(size);
    const t0 = Date.now();
    let out = null, firstByteMs = null;
    const done = () => setTimeout(() => resolve(out), 300);
    const opts = { host: "127.0.0.1", port, path, method: method ?? (size ? "POST" : "GET"), headers: h, agent: false };
    if (tls) Object.assign(opts, { servername: sni, rejectUnauthorized: false });
    const r = (tls ? https : http).request(opts, (res) => {
      const bufs = [];
      out = { status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.alloc(0) };
      res.on("data", (c) => { firstByteMs ??= Date.now() - t0; bufs.push(c); });
      const fin = () => { out.body = Buffer.concat(bufs); out.firstByteMs = firstByteMs; out.endMs = Date.now() - t0; done(); };
      res.on("end", fin); res.on("error", fin); res.on("close", () => out.endMs === undefined && fin());
    });
    r.on("error", (e) => { if (!out) resolve({ status: `ERR ${e.code || e.message}`, err: e }); });
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
const json = (r) => { try { return JSON.parse(r.body.toString()); } catch { return {}; } };
const prod = (o = {}) => req({ host: PROD, ...o });
const stg = (o = {}) => req({ host: STG, auth: true, ...o });
const seenAt = (c) => JSON.parse(sh(["exec", c, "wget", "-qO-", "http://127.0.0.1:3001/__seen"]).stdout || "[]");
const clearSeen = (c) => sh(["exec", c, "wget", "-qO-", "http://127.0.0.1:3001/__clear"]);
const hdrList = (r, name) => r.rawHeaders.reduce((a, v, i) => (i % 2 === 0 && v.toLowerCase() === name ? [...a, r.rawHeaders[i + 1]] : a), []);
const startStub = (name, alias) => sh(["run", "-d", "--name", name, "--network", NET, "--network-alias", alias, "-e", `TAG=${alias}`, "-v", `${dir}:/stub:ro`, "node:22-alpine", "node", "/stub/stub.js"]);
const startNginx = (name, confDir, ports, hash) => sh([
  "run", "-d", "--name", name, "--network", NET, ...ports.flatMap((p) => ["-p", p]),
  "-e", `DOMAIN=${PROD}`, "-e", `STAGING_BASICAUTH_HASH=${hash}`, "-e", "NGINX_ENVSUBST_FILTER=DOMAIN", "-e", "NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx-run/conf.d",
  "-v", `${confDir}:/etc/nginx:ro`, "-v", `${join(dir, "origin")}:/etc/nginx/origin:ro`,
  "--entrypoint", "/bin/sh", IMAGE, "/etc/nginx/scripts/start.sh", "nginx", "-g", "daemon off;",
]);
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(300); }
  return false;
}
const healthy = (c) => () => sh(["exec", c, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/healthz"]).status === 0;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

cleanup();
try {
  console.log(`image under test: ${IMAGE}`);
  // ---- throwaway cert + password hashes (never the real origin cert) ----
  mkdirp(join(dir, "origin"));
  function mkdirp(p) { spawnSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(p)},{recursive:true})`]); }
  const gen = sh(["run", "--rm", "-v", `${join(dir, "origin")}:/o`, "-e", `PW=${PW}`, "alpine:3", "sh", "-ec", `
    apk add -q openssl apache2-utils
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /o/key.pem -out /o/cert.pem -days 2 -subj /CN=${PROD} -addext "subjectAltName=DNS:${PROD},DNS:*.${PROD}" 2>/dev/null
    htpasswd -nbB -C 14 u "$PW" | cut -d: -f2 > /o/b14.txt
    htpasswd -nbB -C 10 u "$PW" | cut -d: -f2 > /o/b10.txt
    openssl passwd -apr1 "$PW" > /o/apr1.txt
    chmod 644 /o/*.pem`]);
  if (gen.status !== 0) throw new Error("cert/hash generation failed: " + gen.stderr);
  const rd = (f) => readFileSync(join(dir, "origin", f), "utf8").trim();
  const swap = (p, rest) => p + rest.slice(4); // "$2y$10$..." -> "$2a$10$..." (same algorithm, different prefix)
  const H = { b14: swap("$2a$", rd("b14.txt")), b10: swap("$2a$", rd("b10.txt")), apr1: rd("apr1.txt") };
  H.b10b = swap("$2b$", H.b10); H.b10y = swap("$2y$", H.b10);

  check("hash generation yields $2a$ bcrypt + apr1", H.b10.startsWith("$2a$10$") && H.b14.startsWith("$2a$14$") && H.apr1.startsWith("$apr1$"));
  sh(["network", "create", NET]);
  let r = startStub(C.app, "app");
  if (r.status !== 0) throw new Error(r.stderr);
  // app-staging deliberately ABSENT while nginx boots: nginx must still start.
  r = startNginx(C.nginx, join(ROOT, "infra/nginx"), [`127.0.0.1:${HTTPS}:443`, `127.0.0.1:${HTTP}:80`], H.b10);
  if (r.status !== 0) throw new Error(r.stderr);
  if (!(await waitFor(healthy(C.nginx)))) throw new Error("nginx not healthy:\n" + sh(["logs", C.nginx]).stdout + sh(["logs", C.nginx]).stderr);
  check("nginx starts and passes /healthz while app-staging is down", true);
  const nt = sh(["exec", C.nginx, "nginx", "-t"]);
  check("nginx -t passes with the repo config", nt.status === 0, nt.stderr);
  await waitFor(async () => (await prod()).status === 200);
  r = await prod();
  check("prod works while staging upstream is down", r.status === 200 && json(r).tag === "app", `${r.status}`);
  r = await stg();
  check("staging upstream down -> 502 (not a hang/crash)", r.status === 502, `${r.status}`);
  startStub(C.staging, "app-staging");
  await waitFor(async () => (await stg()).status === 200);

  // ---- routing ----
  r = await prod(); check("routing: prod host -> app", json(r).tag === "app");
  r = await stg(); check("routing: staging host -> app-staging", json(r).tag === "app-staging");
  r = await prod({ sni: "evil.test", host: "evil.test" });
  check("unknown SNI: TLS handshake rejected", typeof r.status === "string" && r.status.startsWith("ERR"), `${r.status}`);
  r = await req({ tls: false, port: HTTP, host: "evil.test" });
  check("unknown Host on :80 -> connection closed (444)", typeof r.status === "string" && r.status.startsWith("ERR"), `${r.status}`);

  // ---- redirects ----
  for (const h of [PROD, STG]) {
    r = await req({ tls: false, port: HTTP, host: h, path: "/foo//bar?x=1&y=%2F" });
    check(`:80 ${h} -> 308 with exact Location`, r.status === 308 && r.headers.location === `https://${h}/foo//bar?x=1&y=%2F`, `${r.status} ${r.headers?.location}`);
  }

  // ---- basic auth ----
  r = await req({ host: STG }); check("staging: no auth -> 401 + WWW-Authenticate", r.status === 401 && !!r.headers["www-authenticate"], `${r.status}`);
  r = await req({ host: STG, headers: { authorization: "Basic " + Buffer.from("staging:wrong").toString("base64") } });
  check("staging: wrong password -> 401", r.status === 401, `${r.status}`);
  r = await req({ host: STG, headers: { authorization: "Basic " + Buffer.from("other:" + PW).toString("base64") } });
  check("staging: wrong user -> 401", r.status === 401, `${r.status}`);
  r = await stg(); check("staging: staging:<password> -> 200", r.status === 200, `${r.status}`);
  r = await req({ host: STG, path: "/api/health" }); check("staging: no exempt paths (/api/health -> 401)", r.status === 401, `${r.status}`);
  r = await req({ host: STG, path: "/__recognize_anon" }); check("staging: /__recognize_anon without auth -> 404 (internal, never reaches auth/upstream)", r.status === 404, `${r.status}`);
  r = await prod({ path: "/api/health" }); check("prod: no auth needed", r.status === 200, `${r.status}`);

  // ---- forwarded headers + CF-Connecting-IP ----
  const CFIP = "203.0.113.77";
  r = await prod({ path: "/echo?q=1", headers: { "cf-connecting-ip": CFIP, cookie: "better-auth.session_token=SECRETCOOKIEVALUE123", authorization: "Bearer SECRETBEARER456" } });
  const e = json(r), eh = e.headers ?? {};
  check("upstream sees Host = requested host", eh.host === PROD, eh.host);
  check("upstream sees X-Forwarded-Proto=https", eh["x-forwarded-proto"] === "https");
  check("upstream sees X-Forwarded-Host", eh["x-forwarded-host"] === PROD);
  check("upstream sees X-Forwarded-For and X-Real-IP", !!eh["x-forwarded-for"] && !!eh["x-real-ip"], JSON.stringify([eh["x-forwarded-for"], eh["x-real-ip"]]));
  check("CF-Connecting-IP passes through byte-identical, exactly once", eh["cf-connecting-ip"] === CFIP && hdrList({ rawHeaders: e.rawHeaders }, "cf-connecting-ip").length === 1, eh["cf-connecting-ip"]);
  const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs");
  const ci = spawnSync(process.execPath, [tsx, "-e", `
    (async () => { const m = await import(${JSON.stringify("file:///" + join(ROOT, "src/lib/utils/rate-limit.ts").replace(/\\/g, "/"))});
    console.log(m.clientIp(new Request("http://x/", { headers: JSON.parse(process.env.H) }))); })();`],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, H: JSON.stringify(eh) } });
  check("app clientIp() on captured upstream headers == CF-Connecting-IP", ci.stdout?.trim().split("\n").pop() === CFIP, `${ci.stdout} ${ci.stderr?.slice(0, 300)}`);

  // ---- Set-Cookie / Location / URI passthrough ----
  r = await prod({ path: "/cookie" });
  check("302 Location + Set-Cookie arrive unmodified", r.status === 302 && r.headers.location === "https://dojocollect.test/login" && hdrList(r, "set-cookie")[0] === "a=b; Secure; HttpOnly; SameSite=Lax", JSON.stringify([r.headers.location, hdrList(r, "set-cookie")]));
  const uri = "/a//b?x=%2F&y=1&z=%E2%9C%93";
  r = await prod({ path: uri }); check("query/%-encoding/double slashes reach upstream unchanged", json(r).url === uri, json(r).url);

  // ---- security headers ----
  r = await prod({ path: "/hdrs" });
  const set = (n) => hdrList(r, n).sort().join(" | ");
  check("sec headers: exactly one X-Frame-Options (the app's DENY)", set("x-frame-options") === "DENY", set("x-frame-options"));
  check("sec headers: exactly one Referrer-Policy (the app's)", set("referrer-policy") === "no-referrer", set("referrer-policy"));
  check("sec headers: exactly one nosniff", hdrList(r, "x-content-type-options").length === 1);
  check("sec headers: only the app's HSTS, no proxy CSP/Permissions-Policy", hdrList(r, "strict-transport-security").length === 1 && !r.headers["content-security-policy"] && !r.headers["permissions-policy"]);
  check("Server header has no nginx version", r.headers.server === "nginx", r.headers.server);
  r = await stg({ path: "/hdrs" }); check("sec headers also single on staging", hdrList(r, "x-frame-options").length === 1);
  r = await req({ host: STG, path: "/hdrs" }); check("401 from proxy adds no duplicate security headers", r.status === 401 && hdrList(r, "x-frame-options").length === 0);

  // ---- gzip ----
  r = await prod({ path: "/css", headers: { "accept-encoding": "gzip" } });
  check("gzip: >512B text/css compressed + Vary", r.headers["content-encoding"] === "gzip" && /accept-encoding/i.test(r.headers.vary ?? ""), JSON.stringify(r.headers));
  check("  ...and decompresses to the original", gunzipSync(r.body).toString().startsWith("body{color:red}"));
  r = await prod({ path: "/css" }); check("gzip: not compressed without Accept-Encoding", !r.headers["content-encoding"]);
  r = await prod({ path: "/small-css", headers: { "accept-encoding": "gzip" } }); check("gzip: tiny body not compressed", !r.headers["content-encoding"], JSON.stringify(r.headers));
  r = await prod({ path: "/gz", headers: { "accept-encoding": "gzip" } });
  check("gzip: already-encoded upstream not double-compressed", r.headers["content-encoding"] === "gzip" && gunzipSync(r.body).toString().startsWith("body{color:red}"));

  // ---- recognize tiers + global ceiling, both hosts ----
  let seq = 0;
  const REC = "/api/cards/recognize", APP_CAP = 29_010_603;
  const ck = (n) => `better-auth.session_token=${n}`;
  for (const [name, call, c] of [["prod", prod, C.app], ["staging", stg, C.staging]]) {
    // Tag each request with a unique ?n= so late-arriving upstream "close" records from earlier checks can never be mistaken for this one.
    const run = async (o) => {
      const tag = `n=${++seq}`; clearSeen(c);
      const x = await call({ ...o, path: o.path + "?" + tag });
      let up = [];
      for (let i = 0; i < 12; i++) { await sleep(i === 0 ? 500 : 300); up = seenAt(c).filter((s) => s.url.endsWith(tag)); if (up.length || x.status !== 200) break; }
      return { x, up };
    };
    const none = (u) => !u.up.some((s) => s.complete);
    let u = await run({ path: REC, size: 70_000 });
    check(`[${name}] recognize no cookie 70KB CL -> 413, nothing reaches upstream`, u.x.status === 413 && u.up.length === 0, `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: 5 * MB, chunked: true });
    check(`[${name}] recognize no cookie 5MB chunked -> 413, upstream never completes`, u.x.status === 413 && none(u), `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: 20_000 });
    check(`[${name}] recognize no cookie 20KB -> 200 forwarded exactly`, u.x.status === 200 && u.up[0]?.bytes === 20_000, `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: APP_CAP, headers: { cookie: `__Secure-${ck("abc")}` } });
    check(`[${name}] recognize __Secure- cookie 29,010,603 B -> 200 exact`, u.x.status === 200 && u.up[0]?.bytes === APP_CAP && u.up[0]?.complete, `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: APP_CAP, headers: { cookie: `a=1; ${ck("abc")}` } });
    check(`[${name}] recognize plain cookie 29,010,603 B -> 200 exact`, u.x.status === 200 && u.up[0]?.bytes === APP_CAP, `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: 30_000_000, headers: { cookie: ck("abc") } });
    check(`[${name}] recognize cookie 30,000,000 B -> 200`, u.x.status === 200 && u.up[0]?.bytes === 30_000_000, `${u.x.status}`);
    u = await run({ path: REC, size: 30_000_001, headers: { cookie: ck("abc") } });
    check(`[${name}] recognize cookie 30,000,001 B -> 413, upstream never completes`, u.x.status === 413 && none(u), `${u.x.status} ${JSON.stringify(u.up)}`);
    u = await run({ path: REC, size: 31 * MB, chunked: true, headers: { cookie: ck("abc") } });
    check(`[${name}] recognize cookie 31MB chunked -> 413, upstream never completes`, u.x.status === 413 && none(u), `${u.x.status} ${JSON.stringify(u.up)}`);
    for (const p of ["/API/Cards/Recognize", "/api/cards/%72ecognize"]) {
      u = await run({ path: p, size: 5 * MB });
      check(`[${name}] bypass attempt ${p} no cookie 5MB -> 413`, u.x.status === 413 && none(u), `${u.x.status} ${JSON.stringify(u.up)}`);
    }
    u = await run({ path: "/api/other", size: 25 * MB });
    check(`[${name}] /api/other 25MB -> 200 (global ceiling)`, u.x.status === 200 && u.up[0]?.bytes === 25 * MB, `${u.x.status}`);
    u = await run({ path: "/api/other", size: 31 * MB });
    check(`[${name}] /api/other 31MB -> 413 (documented global ceiling)`, u.x.status === 413 && none(u), `${u.x.status}`);
  }
  r = await prod({ path: "/__recognize_anon" }); check("/__recognize_anon direct -> 404 (internal)", r.status === 404, `${r.status}`);
  const reach = await new Promise((res) => { const s = net.connect(8081, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
  check(":8081 healthcheck listener not reachable from host", reach === false);

  // ---- timeouts, streaming ----
  const T = sh(["exec", C.nginx, "nginx", "-T"]).stdout;
  check("rendered config: proxy_read/send 330s, connect 10s", /proxy_read_timeout 330s/.test(T) && /proxy_send_timeout 330s/.test(T) && /proxy_connect_timeout 10s/.test(T));
  check("rendered config: client_max_body_size 30000000 (global + recognize) and 64000 (anon)", /client_max_body_size 30000000;/.test(T) && /client_max_body_size 64000;/.test(T));
  r = await prod({ path: "/slow" }); check("4s-slow upstream delivered (no premature cut)", r.status === 200 && r.body.toString() === "slow-ok" && r.endMs >= 3900, `${r.status} ${r.endMs}`);
  cpSync(join(ROOT, "infra/nginx"), join(dir, "nginx-t"), { recursive: true });
  const pc = join(dir, "nginx-t/snippets/proxy-common.conf");
  writeFileSync(pc, readFileSync(pc, "utf8").replace("proxy_read_timeout 330s", "proxy_read_timeout 2s"));
  startNginx(C.nginxT, join(dir, "nginx-t"), [`127.0.0.1:${HTTPS_T}:443`], H.b10);
  await waitFor(healthy(C.nginxT));
  r = await req({ port: HTTPS_T, host: PROD, path: "/slow" });
  check("proxy_read_timeout governs: 2s override + 4s upstream -> 504", r.status === 504, `${r.status}`);
  sh(["rm", "-f", C.nginxT]);
  r = await prod({ path: "/api/admin/grading-interest/export" });
  check("streaming CSV: first chunk arrives before upstream finishes", r.status === 200 && r.firstByteMs < 1000 && r.endMs >= 1400 && r.body.toString() === "chunk1\nchunk2\n", `first=${r.firstByteMs} end=${r.endMs}`);

  // ---- access log redaction ----
  await stg({ path: "/api/log-probe?token=SECRETQUERY789" });
  const logs = sh(["logs", C.nginx]); const L = logs.stdout + logs.stderr;
  const b64 = AUTH.split(" ")[1];
  check("access log records the path", L.includes("GET /api/log-probe"));
  check("access log never contains Cookie/Authorization/password/base64/query", !/SECRETCOOKIEVALUE123|SECRETBEARER456|SECRETQUERY789/.test(L) && !L.includes(PW) && !L.includes(b64));

  // ---- bcrypt / apr1 latency ----
  const setHash = (h) => sh(["exec", C.nginx, "sh", "-c", `printf 'staging:%s\\n' "$1" > /etc/nginx-run/htpasswd`, "_", h]);
  const lat = {};
  const t = await (async () => { const a = []; for (let i = 0; i < 3; i++) { const s = Date.now(); await prod({ path: "/echo" }); a.push(Date.now() - s - 300); } return median(a); })();
  for (const [k, h] of [["bcrypt $2a$ cost 14", H.b14], ["bcrypt $2a$ cost 10", H.b10], ["bcrypt $2b$ cost 10", H.b10b], ["bcrypt $2y$ cost 10", H.b10y], ["apr1", H.apr1]]) {
    setHash(h);
    const ms = [], st = [];
    for (let i = 0; i < 3; i++) { const s = Date.now(); const x = await stg({ path: "/echo" }); ms.push(Date.now() - s - 300); st.push(x.status); }
    lat[k] = median(ms);
    check(`basic auth accepts ${k} (latency median ${lat[k]} ms)`, st.every((s) => s === 200), JSON.stringify(st));
  }
  console.log(`\nLATENCY (median of 3, ms per authed staging request, 300ms harness settle removed; unauthenticated prod baseline ${t} ms):`);
  console.log(JSON.stringify(lat, null, 2));
  setHash(H.b10);

  // ---- app recreate: runtime re-resolve ----
  const ip = (c) => sh(["inspect", "-f", `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, c]).stdout.trim();
  const oldIp = ip(C.app);
  sh(["rm", "-f", C.app]);
  sh(["run", "-d", "--name", C.spacer, "--network", NET, "alpine:3", "sleep", "600"]);
  startStub(C.app, "app");
  const newIp = ip(C.app);
  const t0 = Date.now();
  const rec = await waitFor(async () => (await prod()).status === 200, 15000);
  check(`app recreate (${oldIp} -> ${newIp}): prod recovers within 15s (${Date.now() - t0} ms)`, rec && newIp !== oldIp, `${oldIp} ${newIp}`);

  // ---- header parity with Caddy ----
  const cf = readFileSync(join(ROOT, "Caddyfile"), "utf8").replace(/\r\n/g, "\n");
  const hb = cf.match(/^[ \t]*header \{[^}]*\}/m)?.[0], enc = cf.match(/^[ \t]*encode gzip\b.*$/m)?.[0];
  if (!hb || !enc) throw new Error("header{} / encode not found in Caddyfile");
  writeFileSync(join(dir, "Caddyfile"), `{\n admin off\n auto_https off\n}\n:80 {\n${hb}\n${enc}\n reverse_proxy app:3000 {\n  header_up Host {host}\n }\n}\n`);
  sh(["run", "-d", "--name", C.caddy, "--network", NET, "-p", `127.0.0.1:${CADDY}:80`, "-v", `${join(dir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`, "caddy:2-alpine"]);
  await waitFor(async () => (await req({ tls: false, port: CADDY, host: PROD, path: "/hdrs" })).status === 200);
  const IGN = new Set(["date", "server", "content-length", "via", "connection", "keep-alive", "transfer-encoding"]);
  // Caddy's header{} duplicates these three; nginx intentionally adds none (single-valued, asserted above), so they are excluded from parity.
  for (const h of ["x-frame-options", "referrer-policy", "x-content-type-options"]) IGN.add(h);
  const norm = (x) => x.rawHeaders.reduce((a, v, i) => (i % 2 === 0 && !IGN.has(v.toLowerCase()) ? [...a, `${v.toLowerCase()}: ${x.rawHeaders[i + 1]}`] : a), []).sort();
  for (const [p, extra] of [["/hdrs", {}], ["/css", { "accept-encoding": "gzip" }], ["/cookie", {}]]) {
    const a = await req({ tls: false, port: CADDY, host: PROD, path: p, headers: extra }), b = await prod({ path: p, headers: extra });
    const da = JSON.stringify(norm(a)), db = JSON.stringify(norm(b));
    check(`Caddy header parity ${p} (status ${a.status} vs ${b.status})`, a.status === b.status && da === db, `\n caddy: ${da}\n nginx: ${db}`);
  }
} catch (err) {
  check("script ran to completion", false, String(err?.stack ?? err));
} finally {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
}
const failed = rows.filter((x) => !x.ok).length;
console.log("\n==== PASS TABLE ====");
for (const x of rows) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.label}`);
console.log(failed === 0 ? `\nALL ${rows.length} CHECKS PASSED` : `\n${failed} OF ${rows.length} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
