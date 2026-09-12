import type { MetadataRoute } from "next";

/**
 * Makes HISAB installable to a phone home screen. This is the only thing a
 * PWA install actually requires (plus HTTPS) — see
 * node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md.
 *
 * Colors mirror the light-theme --background/--primary tokens in
 * app/globals.css so the splash screen and OS install prompt don't jar
 * against the app itself.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HISAB — Accounting",
    short_name: "HISAB",
    description: "Indian double-entry bookkeeping, built for speed.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#4338ca",
    icons: [
      { src: "/manifest-icon-192", sizes: "192x192", type: "image/png" },
      { src: "/manifest-icon-192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/manifest-icon-512", sizes: "512x512", type: "image/png" },
      { src: "/manifest-icon-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
