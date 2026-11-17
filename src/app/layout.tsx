import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "LinkedIn Reachout",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-zinc-300 dark:border-zinc-700">
          <nav className="mx-auto flex w-full max-w-6xl items-center gap-4 px-6 py-3">
            <span className="font-semibold">LinkedIn Reachout</span>
            <Link href="/" className="hover:underline">
              Dashboard
            </Link>
            <Link href="/settings" className="hover:underline">
              Settings
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
