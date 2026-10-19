import type { Metadata } from "next";
import { Geologica, Inter } from "next/font/google";
import { Header } from "../components/Header";
import { BodyBg } from "../components/BodyBg";
import { SwRegister } from "../components/SwRegister";
import "./globals.css";

const geologica = Geologica({
  variable: "--font-geologica",
  subsets: ["latin", "cyrillic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Motion Sport",
  description: "Запис на тренування",
  manifest: "/manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk" className={`${geologica.variable} ${inter.variable} h-full antialiased`}>
      <head>
        <meta name="theme-color" content="#116a73" />
      </head>
      <body className="text-base sm:text-sm min-h-full flex flex-col">
        <BodyBg />
        <Header />
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
