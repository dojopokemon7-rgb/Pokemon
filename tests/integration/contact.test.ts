import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POST /api/contact — public landing contact form. The AWS SES SDK and the rate
 * limiter are mocked (no network, no Redis, nothing is ever really sent). Asserts
 * the check order, the single email's recipient / subject / Reply-To / escaped
 * body, the honeypot, the staging prefix, header-injection stripping, and that
 * failures never claim success or log the message/email.
 */
const ses = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = ses.send;
  },
  SendEmailCommand: class {
    constructor(public input: any) {}
  },
}));

const limiter = vi.hoisted(() => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/utils/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/utils/rate-limit")>()),
  enforceRateLimit: limiter.enforceRateLimit,
}));

import { POST, GET, PUT } from "@/app/api/contact/route";

const URL_ = "http://localhost/api/contact";
const good = {
  name: "Ash Ketchum",
  email: "ash@example.com",
  subject: "Partnership",
  message: "Hello Dojo team, I would like to talk.",
  website: "",
  page: "/contact",
};
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
const sent = () => ses.send.mock.calls[0][0].input;

const ENV_KEYS = [
  "AWS_SES_REGION",
  "AWS_SES_ACCESS_KEY_ID",
  "AWS_SES_SECRET_ACCESS_KEY",
  "EMAIL_FROM",
  "CONTACT_TO_EMAIL",
  "CONTACT_SUBJECT_PREFIX",
  "NEXT_PUBLIC_APP_URL",
  "BETTER_AUTH_URL",
];
const saved: Record<string, string | undefined> = {};
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    AWS_SES_REGION: "ap-south-1",
    AWS_SES_ACCESS_KEY_ID: "test-key",
    AWS_SES_SECRET_ACCESS_KEY: "test-secret",
    EMAIL_FROM: "Dojo <no-reply@example.test>",
    NEXT_PUBLIC_APP_URL: "https://dojocollect.com",
  });
  vi.clearAllMocks();
  limiter.enforceRateLimit.mockResolvedValue(null);
  ses.send.mockResolvedValue({});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("success", () => {
  it("sends exactly one email to dojo.collect@nodwin.com with Reply-To and subject", async () => {
    const res = await POST(post(good));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ses.send).toHaveBeenCalledTimes(1);
    const m = sent();
    expect(m.Destination.ToAddresses).toEqual(["dojo.collect@nodwin.com"]);
    expect(m.FromEmailAddress).toBe("Dojo <no-reply@example.test>");
    expect(m.ReplyToAddresses).toEqual(["ash@example.com"]);
    expect(m.Content.Simple.Subject.Data).toBe("[Dojo Contact] Partnership");
    const text = m.Content.Simple.Body.Text.Data as string;
    for (const s of ["Ash Ketchum", "ash@example.com", "Partnership", "/contact", "Hello Dojo team"]) {
      expect(text).toContain(s);
    }
    expect(text).toMatch(/Submitted at: \d{4}-\d{2}-\d{2}T/);
  });

  it("CONTACT_TO_EMAIL overrides the recipient", async () => {
    process.env.CONTACT_TO_EMAIL = "inbox@example.test";
    await POST(post(good));
    expect(sent().Destination.ToAddresses).toEqual(["inbox@example.test"]);
  });

  it("no subject -> first 60 chars of the message", async () => {
    const message = "m".repeat(80);
    await POST(post({ ...good, subject: "", message }));
    expect(sent().Content.Simple.Subject.Data).toBe(`[Dojo Contact] ${"m".repeat(60)}`);
  });

  it("escapes all user input in the HTML body", async () => {
    await POST(
      post({
        ...good,
        name: `<script>alert("x")</script>`,
        subject: `a & <b>`,
        message: `<img src=x onerror=alert(1)> 'quoted' "double"`,
      })
    );
    const html = sent().Content.Simple.Body.Html.Data as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("a & <b>");
    expect(html).toContain("a &amp; &lt;b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;quoted&#39;");
    expect(html).toContain("&quot;double&quot;");
  });
});

describe("staging prefix", () => {
  it("[STAGING] when the app URL host contains 'staging'", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://staging.dojocollect.com";
    await POST(post(good));
    expect(sent().Content.Simple.Subject.Data).toBe("[STAGING] [Dojo Contact] Partnership");
  });
  it("falls back to BETTER_AUTH_URL", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.BETTER_AUTH_URL = "https://staging.dojocollect.com";
    await POST(post(good));
    expect(sent().Content.Simple.Subject.Data.startsWith("[STAGING] ")).toBe(true);
  });
  it("explicit CONTACT_SUBJECT_PREFIX wins", async () => {
    process.env.CONTACT_SUBJECT_PREFIX = "[QA]";
    await POST(post(good));
    expect(sent().Content.Simple.Subject.Data).toBe("[QA] [Dojo Contact] Partnership");
  });
  it("no prefix on production", async () => {
    await POST(post(good));
    expect(sent().Content.Simple.Subject.Data.startsWith("[Dojo Contact]")).toBe(true);
  });
});

describe("honeypot", () => {
  it("filled -> the SAME success response, nothing sent", async () => {
    const real = await POST(post(good));
    ses.send.mockClear();
    const bot = await POST(post({ ...good, website: "http://spam.example" }));
    expect(ses.send).not.toHaveBeenCalled();
    expect(bot.status).toBe(real.status);
    expect(await bot.text()).toBe(await real.text());
  });
});

describe("validation (400 with field errors)", () => {
  it.each([
    ["name missing", { ...good, name: "  " }, "name"],
    ["name > 100", { ...good, name: "n".repeat(101) }, "name"],
    ["email invalid", { ...good, email: "not-an-email" }, "email"],
    ["email > 254", { ...good, email: `${"a".repeat(250)}@x.io` }, "email"],
    ["subject > 150", { ...good, subject: "s".repeat(151) }, "subject"],
    ["message < 10", { ...good, message: "too short" }, "message"],
    ["message > 5000", { ...good, message: "m".repeat(5001) }, "message"],
  ])("%s", async (_n, body, field) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.fields[field]).toEqual(expect.any(String));
    expect(ses.send).not.toHaveBeenCalled();
  });

  it("invalid JSON -> 400, and a non-object body -> 400", async () => {
    expect((await POST(post(null, {}, "{not json"))).status).toBe(400);
    expect((await POST(post(null, {}, "[1,2]"))).status).toBe(400);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it("boundary values are accepted (name 100, message 10 and 5000, subject 150)", async () => {
    for (const over of [
      { name: "n".repeat(100) },
      { message: "m".repeat(10) },
      { message: "m".repeat(5000) },
      { subject: "s".repeat(150) },
    ]) {
      expect((await POST(post({ ...good, ...over }))).status).toBe(200);
    }
  });
});

describe("request guards", () => {
  it("oversize body -> 413 BEFORE parse (declared and streamed)", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const big = JSON.stringify({ ...good, message: "x".repeat(20 * 1024) });
    // streamed (no usable content-length)
    expect((await POST(post(null, {}, big))).status).toBe(413);
    // declared
    expect((await POST(post(null, { "content-length": String(big.length) }, "{}"))).status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
    expect(ses.send).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("non-JSON content-type -> 415", async () => {
    const res = await POST(post(good, { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it("wrong method -> 405 with Allow: POST", async () => {
    for (const h of [GET, PUT]) {
      const res = h();
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("mismatched Origin -> 403; matching / absent Origin is fine", async () => {
    expect((await POST(post(good, { origin: "https://evil.example", host: "localhost" }))).status).toBe(403);
    expect(ses.send).not.toHaveBeenCalled();
    expect((await POST(post(good, { origin: "http://localhost", host: "localhost" }))).status).toBe(200);
  });

  it("rate limited -> 429 with Retry-After, nothing sent", async () => {
    limiter.enforceRateLimit.mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "42" } })
    );
    const res = await POST(post(good));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(ses.send).not.toHaveBeenCalled();
    // the limiter is keyed by IP on the contact bucket
    expect(limiter.enforceRateLimit.mock.calls[0][1]).toMatchObject({ bucket: "contact", limit: 3 });
    expect(limiter.enforceRateLimit.mock.calls[0][2]).toMatchObject({ kind: "ip" });
  });

  it("checks run in order: origin -> content-type -> rate limit -> size", async () => {
    // a cross-origin request never reaches the limiter
    await POST(post(good, { origin: "https://evil.example", host: "localhost" }));
    expect(limiter.enforceRateLimit).not.toHaveBeenCalled();
    // the limiter runs before the body is read/validated
    limiter.enforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await POST(post({}, {}, "{bad"))).status).toBe(429);
  });
});

describe("failures never claim success", () => {
  const GENERIC = "Could not send your message right now. Please email dojo.collect@nodwin.com.";

  it("SES throws -> 500 generic, no ok:true, log carries no body or email", async () => {
    ses.send.mockRejectedValue(
      Object.assign(new Error("boom for ash@example.com Hello Dojo team"), { name: "SESError" })
    );
    const res = await POST(post(good));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: GENERIC });
    expect(body.ok).toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("ash@example.com");
    expect(logged).not.toContain("Hello Dojo team");
    expect(logged).not.toContain("Ash Ketchum");
  });

  it("SES not configured -> 500 generic, nothing sent", async () => {
    delete process.env.AWS_SES_ACCESS_KEY_ID;
    const res = await POST(post(good));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERIC });
    expect(ses.send).not.toHaveBeenCalled();
  });
});

describe("header injection", () => {
  it("CR/LF in subject cannot add headers (subject is flattened to one line)", async () => {
    await POST(post({ ...good, subject: "Hi\r\nBcc: victim@example.com\nX-Evil: 1" }));
    const subject = sent().Content.Simple.Subject.Data as string;
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toBe("[Dojo Contact] Hi Bcc: victim@example.com X-Evil: 1");
    expect(sent().Destination.ToAddresses).toEqual(["dojo.collect@nodwin.com"]);
  });

  it("CR/LF in the message-derived subject is flattened too", async () => {
    await POST(post({ ...good, subject: "", message: "line one\r\nBcc: v@example.com\nrest of it" }));
    expect(sent().Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
  });

  it("an email with CR/LF is rejected (400) so it can never reach Reply-To", async () => {
    const res = await POST(post({ ...good, email: "ash@example.com\r\nBcc: victim@example.com" }));
    expect(res.status).toBe(400);
    expect(ses.send).not.toHaveBeenCalled();
  });

  it("CONTACT_SUBJECT_PREFIX with CR/LF is flattened", async () => {
    process.env.CONTACT_SUBJECT_PREFIX = "[QA]\r\nBcc: v@example.com";
    await POST(post(good));
    expect(sent().Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
  });
});
