import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Boiler Guardian",
  description: "Live boiler telemetry and analysis, read from Hedera Consensus Service",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
