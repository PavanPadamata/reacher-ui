import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reacher — Bulk Email Verifier",
  description: "Self-hosted bulk email verification powered by Reacher",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
