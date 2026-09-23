import type { Metadata } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = { title: "TubeStat", description: "Маржа по сети сайтов" };

// Applies the saved theme before paint (light by default, per the approved reference).
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
