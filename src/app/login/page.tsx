import { Button } from "@/components/ui/button";
import { GitBranch, Shield } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { handleGithubSignIn } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  // Await the searchParams to extract the callbackUrl
  const { callbackUrl } = await searchParams;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center relative overflow-hidden px-4">
      <div className="absolute top-6 right-6 z-20">
        <ThemeToggle />
      </div>
      {/* Background Gradients to match landing page */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl h-[600px] bg-[radial-gradient(circle_at_center,rgba(146,123,255,0.15)_0%,transparent_60%)] pointer-events-none" />

      <div className="w-full max-w-md p-8 rounded-2xl glass-card border border-white/10 shadow-2xl relative z-10 flex flex-col items-center">
        <div className="w-14 h-14 rounded-xl flex items-center justify-center glow-primary mb-6 bg-primary">
          <Image
            src="/logo.png"
            alt="SecureFlow Logo"
            width={64}
            height={64}
            className="object-contain rounded-md"
          />
        </div>

        <h1 className="font-headline text-3xl font-bold mb-2 tracking-tight">Welcome!!</h1>
        <p className="text-muted-foreground text-center mb-8">
          Sign in to secure your CI/CD pipeline and protect your codebase.
        </p>

        {/* Server Action Form to trigger Auth.js SignIn */}
        <form className="w-full" action={handleGithubSignIn}>
          <input type="hidden" name="callbackUrl" value={callbackUrl || ""} />
          <Button 
            type="submit" 
            size="lg" 
            className="w-full bg-primary text-background hover:bg-primary/90 glow-primary font-semibold h-12 text-md"
          >
            <GitBranch className="w-5 h-5 mr-2" />
            Continue with GitHub
          </Button>
        </form>

        <div className="mt-8 pt-6 border-t border-white/10 w-full flex flex-col items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shield className="w-4 h-4 text-green-400" />
            Secure, automated OAuth login
          </div>
          <Link href="/" className="text-sm text-muted-foreground hover:text-white transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}