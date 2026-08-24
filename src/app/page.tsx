import { redirect } from "next/navigation";

/**
 * Root page — redirects to /login.
 * The actual landing is the Sign In screen (Screen 01).
 */
export default function Home() {
  redirect("/login");
}
