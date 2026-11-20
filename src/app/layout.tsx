import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Remote Inpatient AI — Virtual Ward",
  description: "Hospital-level care, from the comfort of home. Hackathon demo using synthetic patient data only.",
  icons: { icon: "/icon.svg" },
};

// Applies the saved theme before paint (avoids a light flash in dark mode).
const themeScript = `try{var t=localStorage.getItem("ria-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
