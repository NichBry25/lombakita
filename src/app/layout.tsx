import type { Metadata } from "next";
import { DM_Sans, Young_Serif } from "next/font/google";
import { ApplicationHeader } from "@/components/navigation/application-header";
import { SiteFooter } from "@/components/navigation/site-footer";
import { publicEnv } from "@/config/env";
import { NON_INDEXABLE_ROBOTS } from "@/config/indexable-routes";
import { resolveSiteOrigin } from "@/config/site-url";
import { AppProviders } from "./providers";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
});

const youngSerif = Young_Serif({
  variable: "--font-young-serif",
  subsets: ["latin", "latin-ext"],
  weight: "400",
});

export const metadata: Metadata = {
  // Resolves every relative Open Graph and canonical URL below it against this deployment's own
  // origin. Without it Next emits relative OG URLs, which no link-preview scraper can fetch.
  metadataBase: new URL(resolveSiteOrigin()),
  title: publicEnv.appName,
  // Candidacy is open: there is no age band, no enrolment requirement and no eligibility gate
  // anywhere in the product, so the description names everyone who can register rather than
  // students alone.
  description:
    "Temukan kompetisi, beasiswa, dan magang di Indonesia. Terbuka untuk pelajar, mahasiswa, lulusan baru, dan profesional.",
  // Indexing is opt-in. Every page inherits this and only the pages in `STATIC_INDEXABLE_PATHS`
  // and the two public dynamic families override it, so a surface added later is withheld from
  // search until someone deliberately opens it. Withholding a page that should have been listed is
  // a missing visitor; exposing one that should not have been is a disclosure nobody audits for.
  robots: NON_INDEXABLE_ROBOTS,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="id"
      className={`${dmSans.variable} ${youngSerif.variable} h-full antialiased`}
      data-theme="light"
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <AppProviders>
          <a className="skip-link" href="#main-content">
            Lewati ke konten utama
          </a>
          <div className="site-layout">
            <ApplicationHeader />
            <div id="main-content" className="site-main" tabIndex={-1}>
              {children}
            </div>
            <SiteFooter />
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
