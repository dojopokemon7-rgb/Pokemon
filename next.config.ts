import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker multi-stage builds.
  // This copies only the necessary files for production, drastically
  // reducing the final image size.
  output: "standalone",

  // Pin the file-tracing root to THIS project dir. Without it, Next infers
  // the root from the nearest lockfile — and when this checkout lives inside
  // another repo (e.g. a git worktree nested under a parent that has its own
  // package-lock.json), Next picks the PARENT and nests the standalone output
  // under `.next/standalone/<subpath>/server.js`, so the Playwright webServer's
  // `node .next/standalone/server.js` can't find it. Pinning the root keeps
  // the standalone server at `.next/standalone/server.js` everywhere.
  outputFileTracingRoot: import.meta.dirname,

  // Allow Next.js to serve images from Supabase Storage
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },

  // Explicitly mark server-only packages so they are not bundled into
  // client-side code. Add more as the project grows.
  serverExternalPackages: ["@prisma/client", "ioredis"],

  // -----------------------------------------------------------------
  // PWA headers
  // -----------------------------------------------------------------
  // `sw.js` is registered with scope "/" (see PwaRegistrar.tsx). Browsers
  // only allow a service worker to control a scope equal to or "below"
  // the directory it's served from — Service-Worker-Allowed widens that
  // to the whole origin, which is required since /sw.js technically lives
  // at the site root already but some browsers (older Safari) still
  // check this header explicitly.
  //
  // `sw.js` must also never be cached by the browser/CDN: if a stale copy
  // is served, users can get stuck on an old version of the app shell
  // indefinitely. `manifest.json` is safe to revalidate frequently too,
  // since it's tiny and install-metadata changes should propagate fast.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

export default nextConfig;
