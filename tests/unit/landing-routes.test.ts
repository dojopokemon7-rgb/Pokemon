// @vitest-environment node
// Reads the REAL built landing in public/landing (no fs mock) so a broken or
// stale artifact fails here. Guards the sign-up/sign-in wiring and the
// /privacy + /grading-services handlers.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as root } from "../../src/app/route";
import { GET as privacy } from "../../src/app/privacy/route";
import { GET as grading } from "../../src/app/grading-services/route";
import { GET as contact } from "../../src/app/contact/route";

const assets = join(process.cwd(), "public", "landing", "assets");
const bundle = () =>
  readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");

describe("landing routes serve the built pages", () => {
  it.each([
    ["/", root],
    ["/privacy", privacy],
    ["/grading-services", grading],
    ["/contact", contact],
  ] as const)("GET %s -> 200 html referencing /landing/assets", async (_p, handler) => {
    const res = await handler();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("/landing/assets/");
  });

  it("wires CTAs to the app's /signup and /login, not placeholders", () => {
    const js = bundle();
    expect(js).toContain('"/signup"');
    expect(js).toContain('"/login"');
    expect(js).not.toContain("https://example.com/sign");
  });

  it("nav chunk carries both Log in (/login) and Sign up (/signup)", () => {
    const nav = readdirSync(assets).find((f) => /^Nav-.*\.js$/.test(f))!;
    const js = readFileSync(join(assets, nav), "utf8");
    for (const s of ["Log in", "/login", "Sign up", "/signup"]) {
      expect(js).toContain(`"${s}"`);
    }
  });
  it("makes no runtime request to Google Fonts", () => {
    const css = readdirSync(assets)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
    expect(css).not.toContain("gstatic.com");
    expect(css).toContain("/landing/fonts/");
  });
});

describe("Google tag (GA4) + Consent Mode on every landing page", () => {
  it.each([
    ["/", root],
    ["/privacy", privacy],
    ["/grading-services", grading],
    ["/contact", contact],
  ] as const)("%s loads gtag for G-JZKE2D8E9V with consent denied BEFORE config", async (_p, handler) => {
    const html = await (await handler()).text();
    expect(html).toContain("https://www.googletagmanager.com/gtag/js?id=G-JZKE2D8E9V");
    const def = html.indexOf("gtag('consent', 'default'");
    const cfg = html.indexOf("gtag('config', 'G-JZKE2D8E9V')");
    expect(def).toBeGreaterThan(-1);
    expect(cfg).toBeGreaterThan(def);
    expect(html.indexOf("gtag('js'")).toBeGreaterThan(def);
    for (const k of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
      expect(html.slice(def, cfg)).toMatch(new RegExp(`${k}: 'denied'`));
    }
    expect(html).not.toContain("cloudflareinsights");
  });

  it("consent banner chunk exists and shares the app's storage key + event", () => {
    const f = readdirSync(assets).find((n) => /^ConsentBanner-.*\.js$/.test(n))!;
    expect(f).toBeTruthy();
    const js = readFileSync(join(assets, f), "utf8");
    expect(js).toContain("dojo-analytics-consent");
    expect(js).toContain("dojo-consent-changed");
    expect(js).toContain("analytics_storage");
    expect(js).not.toContain("ad_storage");
  });
});

describe("contact page", () => {
  const pages = [
    ["/", root],
    ["/privacy", privacy],
    ["/grading-services", grading],
    ["/contact", contact],
  ] as const;

  it("GET /contact is html and carries the form entry (labels, honeypot, success copy)", async () => {
    const res = await contact();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("<title>Contact");
    const entry = /src="\/landing\/assets\/(contact-[^"]+\.js)"/.exec(html)![1];
    const js = readFileSync(join(assets, entry), "utf8");
    for (const s of ["Name", "Email", "Message", "Send message", "website", "/api/contact"]) {
      expect(js, s).toContain(s);
    }
    expect(js).toContain("Thanks — we'll get back to you.");
    expect(js).toContain("dojo.collect@nodwin.com");
  });

  it("the Footer links to /contact on all 4 pages", async () => {
    // the Footer is a shared chunk (app-*.js), loaded by every page's entry
    const app = readdirSync(assets).find((f) => /^app-.*\.js$/.test(f))!;
    expect(readFileSync(join(assets, app), "utf8")).toMatch(/href:"\/contact",children:"Contact"/);
    for (const [p, handler] of pages) {
      const html = await (await handler()).text();
      expect(html, p).toMatch(/modulepreload[^>]+assets\/app-[^"]+\.js/);
    }
  });
});

describe("built landing references resolve", () => {
  const root_ = join(process.cwd(), "public", "landing");
  // every local url (src/href/url()/"/landing/..." string) must exist under public/landing
  const refs = (text: string) => {
    const out = new Set<string>();
    for (const m of text.matchAll(/(?:src|href)="(\/landing\/[^"#?]+)"|url\((?:"|')?(\/landing\/[^)"'#?]+)|["'`](\/landing\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)["'`]/g)) {
      out.add(m[1] ?? m[2] ?? m[3]);
    }
    return [...out];
  };
  it("html, css and js only point at files that exist", () => {
    const files = [
      ...readdirSync(root_).filter((f) => f.endsWith(".html")).map((f) => join(root_, f)),
      ...readdirSync(assets).filter((f) => /\.(js|css)$/.test(f)).map((f) => join(assets, f)),
    ];
    expect(readdirSync(root_).filter((f) => f.endsWith(".html")).sort()).toEqual([
      "contact.html",
      "grading-services.html",
      "index.html",
      "privacy.html",
    ]);
    const missing: string[] = [];
    for (const f of files) {
      for (const r of refs(readFileSync(f, "utf8"))) {
        if (!existsSync(join(root_, r.slice("/landing/".length)))) missing.push(`${f} -> ${r}`);
      }
    }
    expect(missing).toEqual([]);
  });
});