import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "../components/theme-provider";
import { Toaster } from "@sentinel-act/ui/components/ui/sonner";

export const metadata: Metadata = {
  title: "Sentinel Act — Web Governance Console",
  description: "Human-in-the-loop review console for Sentinel Act compliance obligations."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
