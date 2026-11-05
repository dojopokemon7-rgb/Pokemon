import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * C-3 — password-reset rate limiting on POST /api/auth/[...all].
 *
 * The forgot-password page calls authClient.requestPasswordReset(), which Better
 * Auth routes to POST /api/auth/request-password-reset (core password route).
 * That path was NOT matched by the catch-all's rate-limit prefixes (sign-in,
 * sign-up, email-otp), so it was unlimited per IP. This proves:
 *
 *   - the reset path over the auth-tier cap → 429 (limiter enforced, not mocked
 *     — we drive the Redis INCR reply), and the Better Auth handler is NOT
 *     reached (no email triggered);
 *   - sign-in / sign-up / email-otp stay limited exactly as before;
 *   - an UNRELATED auth route (get-session / sign-out / the token-submission
 *     reset-password step) is NOT newly limited — the handler runs even over
 *     the cap;
 *   - the reset 429 is identical regardless of whether the email exists — the
 *     limiter fires BEFORE the handler, so it adds no enumeration oracle.
 *
 * Better Auth + Redis are MOCKED (no live DB / network).
 */

// Better Auth handlers → spies, so we can assert whether the underlying handler
// was reached (i.e. whether the limiter short-circuited the request).
const baHandlers = vi.hoisted(() => ({
  GET: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  POST: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
}));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: () => baHandlers }));

// Redis mock whose INCR reply we control → the limiter genuinely enforces.
const redisState = vi.hoisted(() => ({ incrReply: 1 as number | Error }));
const redisMock = vi.hoisted(() => {
  const state = redisState;
  const multi = vi.fn(() => {
    const chain = {
      incr: vi.fn(() => chain),
      expire: vi.fn(() => chain),
      exec: vi.fn(async () => {
        if (state.incrReply instanceof Error) throw state.incrReply;
        return [[null, state.incrReply]];
      }),
    };
    return chain;
  });
  return { multi, ttl: vi.fn(async () => 60) };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { POST, GET } from "@/app/api/auth/[...all]/route";

function post(path: string, body: unknown = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}
function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisState.incrReply = 1; // allow by default
  delete process.env.RATELIMIT_AUTH_PER_MIN; // default 10/min
});

describe("C-3 — reset path is rate-limited", () => {
  it("POST /api/auth/request-password-reset over the cap → 429, handler NOT reached", async () => {
    redisState.incrReply = 11; // > auth-tier default 10
    const res = await POST(post("/api/auth/request-password-reset", { email: "a@b.com" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too Many Requests");
    // The reset email is never triggered — the limiter short-circuits before Better Auth.
    expect(baHandlers.POST).not.toHaveBeenCalled();
  });

  it("the legacy alias /api/auth/forget-password is also limited", async () => {
    redisState.incrReply = 11;
    const res = await POST(post("/api/auth/forget-password", { email: "a@b.com" }));
    expect(res.status).toBe(429);
    expect(baHandlers.POST).not.toHaveBeenCalled();
  });

  it("under the cap, the reset request passes through to Better Auth (email flow intact)", async () => {
    redisState.incrReply = 1;
    const res = await POST(post("/api/auth/request-password-reset", { email: "a@b.com" }));
    expect(res.status).toBe(200);
    expect(baHandlers.POST).toHaveBeenCalledTimes(1);
  });

  it("the 429 is identical whether or not the account exists (no enumeration oracle)", async () => {
    redisState.incrReply = 11;
    const resExisting = await POST(post("/api/auth/request-password-reset", { email: "real@user.com" }));
    const resMissing = await POST(post("/api/auth/request-password-reset", { email: "nobody@nowhere.com" }));
    expect(resExisting.status).toBe(429);
    expect(resMissing.status).toBe(429);
    // Same body shape, and the handler (which alone knows if the account exists)
    // was never consulted in either case.
    expect(await resExisting.json()).toEqual(await resMissing.json());
    expect(baHandlers.POST).not.toHaveBeenCalled();
  });
});

describe("C-3 — existing coverage unchanged, no over-broadening", () => {
  it("sign-in is still limited over the cap", async () => {
    redisState.incrReply = 11;
    const res = await POST(post("/api/auth/sign-in/email", { email: "a@b.com", password: "x" }));
    expect(res.status).toBe(429);
    expect(baHandlers.POST).not.toHaveBeenCalled();
  });

  it("sign-up and email-otp are still limited over the cap", async () => {
    redisState.incrReply = 11;
    const up = await POST(post("/api/auth/sign-up/email", { email: "a@b.com" }));
    expect(up.status).toBe(429);
    const otp = await POST(post("/api/auth/email-otp/verify-email", { email: "a@b.com" }));
    expect(otp.status).toBe(429);
  });

  it("an UNRELATED route (sign-out) is NOT newly limited — handler runs even over the cap", async () => {
    redisState.incrReply = 11; // would 429 IF it were in the limited set
    const res = await POST(post("/api/auth/sign-out"));
    expect(res.status).toBe(200);
    expect(baHandlers.POST).toHaveBeenCalledTimes(1);
  });

  it("the token-SUBMISSION step /reset-password is NOT limited (only the request path is)", async () => {
    redisState.incrReply = 11;
    const res = await POST(post("/api/auth/reset-password", { token: "t", newPassword: "x" }));
    expect(res.status).toBe(200);
    expect(baHandlers.POST).toHaveBeenCalledTimes(1);
  });

  it("GET get-session is never limited (exported unwrapped)", async () => {
    redisState.incrReply = 11;
    const res = await GET(get("/api/auth/get-session"));
    expect(res.status).toBe(200);
    expect(baHandlers.GET).toHaveBeenCalledTimes(1);
    // GET never touches the limiter's atomic counter.
    expect(redisMock.multi).not.toHaveBeenCalled();
  });
});
