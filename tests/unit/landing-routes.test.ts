// @vitest-environment node
// Reads the REAL built landing in public/landing (no fs mock) so a broken or
// stale artifact fails here. Guards the sign-up/sign-in wiring and the
// /privacy + /grading-services handlers.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GET as root } from "../../src/app/route";
import { GET as privacy } from "../../src/app/privacy/route";
import { GET as grading } from "../../src/app/grading-services/route";

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

  it("makes no runtime request to Google Fonts", () => {
    const css = readdirSync(assets)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
    expect(css).not.toContain("gstatic.com");
    expect(css).toContain("/landing/fonts/");
  });
});
