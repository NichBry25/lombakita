import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { publicEnv } from "@/config/env";
import { AppProviders } from "./providers";
import { NotificationBell } from "./notification-bell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      data-theme="light"
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <AppProviders>
          {/* Mounted once at the root so the notification poll + ping persist across every route
              (not just the homepage). Self-hides for signed-out users; relocates into a proper
              global header during the design pass per DEC-0080. */}
          <NotificationBell />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
