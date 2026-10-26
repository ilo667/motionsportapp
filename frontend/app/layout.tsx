import type { Metadata } from "next";
import { Rubik, Inter } from "next/font/google";
import { SwRegister } from "../components/SwRegister";
import { OfflineBanner } from "../components/OfflineBanner";
import "./globals.css";

const rubik = Rubik({
  weight: ["700"],
  variable: "--font-geologica",
  subsets: ["latin", "cyrillic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Motion Gym",
  description: "Управління тренуваннями для тренерів і клієнтів",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk" className={`${rubik.variable} ${inter.variable} h-full antialiased`}>
      <head>
        <meta name="theme-color" content="#070910" />
      </head>
      <body className="text-base sm:text-sm min-h-full flex flex-col">
        <OfflineBanner />
        <main className="flex-1 flex flex-col px-5">
          <div className="w-full max-w-xl mx-auto flex-1 flex flex-col">{children}</div>
        </main>
        <SwRegister />
      </body>
    </html>
  );
}
