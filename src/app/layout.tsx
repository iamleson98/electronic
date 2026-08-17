import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CircuitLab — Interactive Circuit Simulator",
  description: "Beautiful web-based circuit simulator with drag-and-drop editing, MNA solver, oscilloscope, and plugin architecture. Build circuits with resistors, capacitors, transistors, 555 timers, Arduino, Raspberry Pi and more.",
  keywords: ["circuit simulator", "MNA", "electronics", "Falstad", "Arduino", "555 timer", "oscilloscope", "SPICE"],
  authors: [{ name: "CircuitLab" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "CircuitLab",
    description: "Interactive circuit simulator with drag-and-drop UI and plugin architecture",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CircuitLab",
    description: "Interactive circuit simulator with drag-and-drop UI and plugin architecture",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-0 focus:top-0 focus:z-50 focus:rounded focus:bg-slate-800 focus:px-4 focus:py-2 focus:text-sm">
          Skip to main content
        </a>
        {children}
        <Toaster />
        <SonnerToaster richColors closeButton position="bottom-right" />
      </body>
    </html>
  );
}
