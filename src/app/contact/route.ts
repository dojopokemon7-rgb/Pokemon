import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Streams the landing's prebuilt contact.html (route handlers bypass layout.tsx).
// The page's form POSTs to /api/contact (src/app/api/contact/route.ts).
export async function GET() {
  const file = join(process.cwd(), "public", "landing", "contact.html");
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
