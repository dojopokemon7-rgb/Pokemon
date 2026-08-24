import type { Metadata, Viewport } from "next";
import { Ubuntu_Sans, Marcellus } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import PwaRegistrar from "@/components/PwaRegistrar";

// Reference prototype uses 'Ubuntu Sans' for --font-display/--font-body
// (dojo-prototype/styles.css: --font-display:'Ubuntu Sans',system-ui,...).
// Previously this loaded Archivo, which has different letterforms/spacing —
// that mismatch was the root cause of the "alignment looks different" report.
const ubuntuSans = Ubuntu_Sans({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--font-ubuntu-sans",
  display: "swap",
});

const marcellus = Marcellus({
  subsets: ["latin"],
  weight: ["400"],
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
  maximumScale: 1,
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

