import type { Metadata } from "next";
import { Russo_One, Inter } from "next/font/google";
import { Header } from "../components/Header";
import { SwRegister } from "../components/SwRegister";
import "./globals.css";

const russoOne = Russo_One({
  weight: "400",
  variable: "--font-geologica",
  subsets: ["latin", "cyrillic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Motion Gym",
  description: "Запис на тренування",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk" className={`${russoOne.variable} ${inter.variable} h-full antialiased`}>
      <head>
        <meta name="theme-color" content="#93d23c" />
      </head>
      <body className="text-base sm:text-sm min-h-full flex flex-col">
        <Header />
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
