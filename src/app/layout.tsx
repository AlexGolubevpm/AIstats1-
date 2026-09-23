import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TubeStat",
  description: "Маржа по сети сайтов",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
