import Link from "next/link";
import { auth } from "@/auth"; 
import { Button } from "@/components/ui/button";

export async function LoginButton() {
  // Retrieve the session from NextAuth on the server
  const session = await auth();

  // If a session exists, the user is logged in
  const isLoggedIn = !!session;

  return (
    // Update the href to point to the new /login route
    <Link href={isLoggedIn ? "/dashboard" : "/login"}>
      <Button className="hover:border-primary/30 hover:bg-primary/5" variant="outline">
        {isLoggedIn ? "Dashboard" : "Login"}
      </Button>
    </Link>
  );
}