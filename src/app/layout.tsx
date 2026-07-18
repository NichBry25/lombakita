import type { Metadata } from "next";
import { DM_Mono, DM_Sans, DM_Serif_Display } from "next/font/google";
import { ApplicationHeader } from "@/components/navigation/application-header";
import { SiteFooter } from "@/components/navigation/site-footer";
import { publicEnv } from "@/config/env";
import { AppProviders } from "./providers";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const dmSerifDisplay = DM_Serif_Display({
  variable: "--font-dm-serif",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: publicEnv.appName,
  description: "Platform peluang mahasiswa Indonesia — kompetisi, beasiswa, dan magang.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="id"
      className={`${dmSans.variable} ${dmMono.variable} ${dmSerifDisplay.variable} h-full antialiased`}
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
