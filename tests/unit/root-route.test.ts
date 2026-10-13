// @vitest-environment node
// Server-only route handler: use the Node environment so the WHATWG `Response`
// (incl. Response.redirect) matches the runtime, not jsdom's partial shim.
import { describe, it, expect, vi } from "vitest";

// The root route handler (src/app/route.ts) streams the prebuilt landing
// index.html from public/landing/ and fails soft to /login if that artifact
// is missing (RULE 7). Mock readFile so no real file/DB/network is touched.
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile, default: { readFile } }));

import { GET } from "../../src/app/route";

describe("GET / (root route handler)", () => {
  it("serves public/landing/index.html as 200 text/html", async () => {
    readFile.mockResolvedValue('<!doctype html><html><body><div id="root"></div></body></html>');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('<div id="root">');
  });

  it("fails soft with a 307 redirect to /login when the artifact is missing", async () => {
    // async wrapper so the rejection is observed through the mock cleanly.
    readFile.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    const res = await GET();
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toMatch(/\/login$/);
  });
});
