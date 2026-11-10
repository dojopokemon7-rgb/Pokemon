import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  posthogOrigins,
} from "@/lib/utils/csp";

function directive(csp: string, name: string): string {
  const d = csp.split("; ").find((x) => x.startsWith(`${name} `));
  if (!d) throw new Error(`missing directive ${name}`);
  return d;
}

describe("CSP PostHog allowlist", () => {
  it("defaults to the EU origins when no host is configured", () => {
    const csp = buildContentSecurityPolicy(undefined);
    const connect = directive(csp, "connect-src");
    const script = directive(csp, "script-src");
    expect(connect).toContain("https://eu.i.posthog.com");
    expect(connect).toContain("https://eu-assets.i.posthog.com");
    expect(script).toContain("https://eu-assets.i.posthog.com");
    // ingest host is NOT a script origin (minimal allowlist)
    expect(script).not.toContain("https://eu.i.posthog.com");
  });

  it("derives US origins from a US host", () => {
    const csp = buildContentSecurityPolicy("https://us.i.posthog.com");
    expect(directive(csp, "connect-src")).toContain("https://us-assets.i.posthog.com");
    expect(directive(csp, "script-src")).toContain("https://us-assets.i.posthog.com");
    expect(csp).not.toContain("eu.i.posthog.com");
  });

  it("uses a self-hosted/proxy host for both ingest and assets", () => {
    expect(posthogOrigins("https://ph.example.com/")).toEqual({
      ingest: "https://ph.example.com",
      assets: "https://ph.example.com",
    });
  });

  it("falls back to EU on an unparseable host", () => {
    expect(posthogOrigins("not a url").ingest).toBe("https://eu.i.posthog.com");
  });

  it("keeps worker-src blob: and the existing hardening untouched", () => {
    const csp = buildContentSecurityPolicy(undefined);
    expect(directive(csp, "worker-src")).toBe("worker-src 'self' blob:");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "script-src")).toContain("https://cdn.jsdelivr.net");
    expect(directive(csp, "connect-src")).toContain("https://huggingface.co");
    // no wildcard PostHog allowance
    expect(csp).not.toMatch(/\*\.posthog\.com/);
  });
});

describe("CSP landing variant (GA4)", () => {
  it("app policy has no Google Analytics origins", () => {
    const csp = buildContentSecurityPolicy(undefined);
    expect(csp).not.toContain("googletagmanager");
    expect(csp).not.toContain("google-analytics");
  });
  it("landing policy adds exactly the GA4 origins to script/connect/img", () => {
    const csp = buildContentSecurityPolicy(undefined, { landing: true });
    expect(directive(csp, "script-src")).toContain("https://www.googletagmanager.com");
    expect(directive(csp, "script-src")).toContain("'unsafe-inline'");
    const c = directive(csp, "connect-src");
    for (const o of ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"]) {
      expect(c).toContain(o);
    }
    expect(directive(csp, "img-src")).toContain("https://*.google-analytics.com");
    expect(directive(csp, "img-src")).toContain("https://www.googletagmanager.com");
  });
});
