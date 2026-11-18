import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function FindingNotFound() {
  return (
    <div className="container mx-auto py-16 px-4 max-w-xl text-center">
      <Card className="border-white/10 bg-black/40 backdrop-blur-md shadow-2xl">
        <CardHeader className="pb-4 flex flex-col items-center">
          <div className="p-3.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 mb-2">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Finding Not Found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
            The security finding you are looking for does not exist, may have been deleted, or you
            do not have permission to access it.
          </p>

          <div className="pt-2">
            <Button asChild variant="default" className="gap-2">
              <Link href="/dashboard/findings">
                <ArrowLeft className="w-4 h-4" />
                Back to Findings
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
