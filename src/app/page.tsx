export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="shell">
      <h1>TubeStat</h1>
      <p className="muted">Деплой работает. Ингест, дашборды и MCP появятся следующими PR.</p>
      <p className="mono">version {process.env.APP_VERSION ?? "dev"}</p>
    </main>
  );
}
