import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The landing is a prebuilt static artifact (see docs/). We stream its
// index.html from public/landing/ so / returns the marketing page without the
// app's root layout wrapping it (route handlers bypass layout.tsx). Assets are
// served separately by Next's public/ static handler under /landing/*.
export async function GET() {
  const file = join(process.cwd(), "public", "landing", "index.html");
  try {
    const html = await readFile(file, "utf8");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Entry HTML names hashed assets; revalidate so a redeploy's new
        // hashes are picked up (the hashed assets themselves are immutable).
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  } catch {
    // Build artifact missing (landing not copied). Fail soft to the app so a
    // missing marketing page never bricks the deployment (RULE 7).
    return Response.redirect(
      new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
      307,
    );
  }
}
