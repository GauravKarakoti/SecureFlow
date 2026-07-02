import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'SecureFlow',
  description: 'AI-powered secure workflow management platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full antialiased bg-background text-foreground`}>
        {/* 🌙 Use our new ThemeProvider across the application */}
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}