import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev Traffic Sim",
  description: "Interactive traffic-control simulator.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
