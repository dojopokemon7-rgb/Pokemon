import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Providers from "./providers";
import PwaRegistrar from "@/components/PwaRegistrar";

// Reference prototype uses 'Ubuntu Sans' for --font-display/--font-body
// (dojo-prototype/styles.css: --font-display:'Ubuntu Sans',system-ui,...).
// Previously this loaded Archivo, which has different letterforms/spacing —
// that mismatch was the root cause of the "alignment looks different" report.
// Self-hosted (next/font/local): removes the build-time fetch to Google that
// intermittently crashed `next build` (vercel/next.js#99114). Same CSS variable
// names/display as the former next/font/google config. Latin subset only,
// matching the previous `subsets: ["latin"]`. See src/fonts/README.md.
const ubuntuSans = localFont({
  src: [
    { path: "../fonts/UbuntuSans-latin-normal.woff2", weight: "100 800", style: "normal" },
    { path: "../fonts/UbuntuSans-latin-italic.woff2", weight: "100 800", style: "italic" },
  ],
  variable: "--font-ubuntu-sans",
  display: "swap",
});
const marcellus = localFont({
  src: [{ path: "../fonts/Marcellus-latin-400.woff2", weight: "400", style: "normal" }],
  variable: "--font-marcellus",
  display: "swap",
});
export const metadata: Metadata = {
  title: {
    default: "Dojo — TCG Collection",
    template: "%s · Dojo",
  },
  description:
    "The premium app for Pokémon and One Piece TCG collectors. Track, value, and grow your collection.",
  manifest: "/manifest.json",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  ),
  openGraph: {
    title: "Dojo — TCG Collection",
    description:
      "Track, value, and grow your Pokémon & One Piece TCG collection.",
    type: "website",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // Apple ignores <link rel="manifest">/theme-color for install metadata,
    // so iOS Safari relies on this tag to size the home-screen icon.
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    // Enables "Add to Home Screen" standalone chrome (no Safari UI) on iOS.
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Dojo",
  },
};

export const viewport: Viewport = {
  themeColor: "#0D0D0D",
  width: "device-width",
  initialScale: 1,
  // No maximumScale — pinch-zoom must stay enabled. Capping it at 1
  // (effectively user-scalable=no) fails WCAG 1.4.4 / Lighthouse's
  // "[user-scalable=no] or maximum-scale<5" accessibility audit.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${ubuntuSans.variable} ${marcellus.variable}`}
    >
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
        {/* Registers the service worker after load; renders nothing and
            never blocks hydration of the main content above. */}
        <PwaRegistrar />
      </body>
    </html>
  );
}

