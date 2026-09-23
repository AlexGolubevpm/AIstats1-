// MCP over streamable HTTP, stateless JSON responses. Bearer token issued on /settings/access.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyMcpToken } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { createMcpServer } from "@/server/mcp/server";

export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
  if (!(await verifyMcpToken(db, bearer, config().mcpToken))) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="tubestat"' } });
  }
  const server = await createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
