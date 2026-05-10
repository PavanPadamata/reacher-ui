import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reacher — Bulk Email Verifier",
  description: "Self-hosted bulk email verification at scale",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{
          __html: `
            try {
              const t = localStorage.getItem('theme') || 'light';
              document.documentElement.setAttribute('data-theme', t);
            } catch(e) {}
          `
        }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
