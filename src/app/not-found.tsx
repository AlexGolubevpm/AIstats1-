import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="card max-w-sm p-8 text-center">
        <div className="text-4xl font-semibold text-faint">404</div>
        <h1 className="mt-2 text-lg font-semibold">Страница не найдена</h1>
        <p className="mt-1 text-sm text-muted">Возможно, сайт или бандл переименовали, или ссылка устарела.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">На сводку →</Link>
      </div>
    </main>
  );
}
