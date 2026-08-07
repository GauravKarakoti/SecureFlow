import type { Metadata, Viewport } from 'next';
import { SessionProvider } from 'next-auth/react'; // 1. Import the Provider
import { auth } from '@/auth'; // 2. Import your auth config
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';

export const metadata: Metadata = {
  title: 'SecureFlow | AI Security Gatekeeper',
  description: 'AI-Powered Security Gatekeeper for CI/CD Pull Requests',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// 3. Make the layout an async function to fetch the session
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Fetch the session on the server to prevent client-side loading flickers
  const session = await auth();

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="font-body antialiased selection:bg-primary/30 selection:text-primary">
        {/* 4. Wrap your app in the SessionProvider */}
        <SessionProvider session={session}>
          <ThemeProvider>{children}</ThemeProvider>
          <Toaster />
        </SessionProvider>
      </body>
    </html>
  );
}