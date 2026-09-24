import { Logo } from "@/components/layout/logo";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-2">
          <Logo />
          <span className="text-lg font-semibold">TubeStat</span>
        </div>
        <LoginForm next={next ?? "/"} />
      </div>
    </main>
  );
}
