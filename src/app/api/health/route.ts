// Liveness probe for the Docker healthcheck and deploy script.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    version: process.env.APP_VERSION ?? "dev",
    time: new Date().toISOString(),
  });
}
