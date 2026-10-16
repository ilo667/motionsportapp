import type { Metadata } from "next";
import { Geologica, Inter } from "next/font/google";
import { Header } from "../components/Header";
import { BodyBg } from "../components/BodyBg";
import "./globals.css";

const geologica = Geologica({
  variable: "--font-geologica",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MotionSport",
  description: "Track your sports performance with MotionSport.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geologica.variable} ${inter.variable} h-full antialiased`}>
      <body className="text-base sm:text-sm min-h-full flex flex-col">
        <BodyBg />
        <Header />
        {children}
      </body>
    </html>
  );
}
