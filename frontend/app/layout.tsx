import type { Metadata } from "next";
import { Rubik, Inter } from "next/font/google";
// TODO: Header is commented out — may be needed later for authenticated pages
// import { Header } from "../components/Header";
import { MotionGymLogo } from "../components/MotionGymLogo";
import { SwRegister } from "../components/SwRegister";
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
        <meta name="theme-color" content="#93d23c" />
      </head>
      <body className="text-base sm:text-sm min-h-full flex flex-col">
        <main className="flex-1 flex flex-col px-5">
          <div className="w-full max-w-xl mx-auto pb-12 flex-1 flex flex-col justify-center">
            <MotionGymLogo className="w-[120px] h-[120px] sm:w-[150px] sm:h-[150px] mx-auto mb-6" />
            {children}
          </div>
        </main>
        <SwRegister />
      </body>
    </html>
  );
}