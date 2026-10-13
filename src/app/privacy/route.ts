import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Streams the landing's prebuilt privacy.html (route handlers bypass layout.tsx).
export async function GET() {
  const file = join(process.cwd(), "public", "landing", "privacy.html");
  try {
    const html = await readFile(file, "utf8");
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
