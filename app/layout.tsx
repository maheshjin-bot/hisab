import type { Metadata } from "next";
import { Geist_Mono, Inter, Source_Serif_4 } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Three typefaces, three jobs. One grotesque doing all three is what makes an
 * accounting tool read as a generic dashboard.
 */

// Interface: every label, table, form and menu. cv11 gives a single-storey
// "l" so it can't be confused with a "1" or an "I" in a ledger name.
const sans = Inter({
  variable: "--font-sans-face",
  subsets: ["latin"],
  axes: ["opsz"],
});

// Statement: report and printed-statement titles only. Financial statements
// have always been set with serif headings, so a Balance Sheet titled in a
// serif reads as a document rather than a dashboard widget. Confined to five
// report pages and printed output, so one weight is enough.
const display = Source_Serif_4({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600"],
});

// Figures: voucher numbers, shortcut hints, amounts in dense grids.
const mono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HISAB — Accounting",
  description: "Indian double-entry bookkeeping, built for speed.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable} h-full antialiased`}
      // next-themes writes class and style on <html> before React hydrates,
      // which is a hydration mismatch by construction.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
