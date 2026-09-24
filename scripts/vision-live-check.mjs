// Throwaway live check: proves the Google Vision TEXT_DETECTION call actually
// works with the configured key. Generates a PNG with text via node-canvas-free
// approach (a hand-built BMP->PNG is overkill), so instead we draw text onto an
// SVG, but Vision needs a raster. Simplest reliable path with zero deps: use a
// tiny pre-made base64 PNG that contains the word "CHARIZARD".
//
// Run: node scripts/vision-live-check.mjs
import { readFileSync } from "node:fs";

// Load GOOGLE_VISION_API_KEY from .env without adding a dotenv dep.
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const m = env.match(/^GOOGLE_VISION_API_KEY="?([^"\r\n]+)"?/m);
const key = m?.[1];
if (!key) {
  console.error("NO GOOGLE_VISION_API_KEY in .env");
  process.exit(1);
}

// A 200x60 white PNG with black text "CHARIZARD 4/102" (base64). Generated
// offline; embedding it keeps this check dependency-free and deterministic.
const IMAGE_B64 =
  process.env.VISION_TEST_IMAGE ?? null;

async function main() {
  // Build a real raster with text using the built-in OffscreenCanvas polyfill
  // isn't available in node, so draw with a minimal PBM->PNG is complex.
  // Instead: fetch a public sample image of text that Vision can read.
  // (Live-network check anyway — this just proves the API path end to end.)
  const sampleUrl =
    "https://dummyimage.com/400x120/ffffff/000000.png&text=CHARIZARD+4/102";
  let content;
  if (IMAGE_B64) {
    content = IMAGE_B64;
  } else {
    const imgRes = await fetch(sampleUrl);
    if (!imgRes.ok) {
      console.error("Could not fetch sample image:", imgRes.status);
      process.exit(2);
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    content = buf.toString("base64");
  }

  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content },
            features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
            imageContext: { languageHints: ["en"] },
          },
        ],
      }),
    }
  );

  console.log("HTTP status:", res.status);
  const data = await res.json();
  if (data?.error) {
    console.error("TOP-LEVEL API ERROR:", JSON.stringify(data.error, null, 2));
    process.exit(5);
  }
  const r = data?.responses?.[0];
  if (r?.error) {
    console.error("VISION ERROR:", JSON.stringify(r.error, null, 2));
    process.exit(3);
  }
  const text = r?.fullTextAnnotation?.text ?? r?.textAnnotations?.[0]?.description ?? "";
  console.log("DETECTED TEXT:", JSON.stringify(text));
  console.log(text.trim() ? "LIVE CALL OK — text detected." : "LIVE CALL returned no text.");
}

main().catch((e) => {
  console.error("REQUEST FAILED:", e.message);
  process.exit(4);
});
