import type { NextConfig } from "next";

// BASE_PATH ("" or "/admin") is fixed at build time: the Docker image is built for one path (docs/CICD.md#domain).
const BASE_PATH = (process.env.BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (.next/standalone).
  output: "standalone",
  agentRules: false,
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "bullmq", "ioredis"],
  ...(BASE_PATH ? { basePath: BASE_PATH } : {}),
  // Inlined into server and client code alike: plain <a href>, cookie path and the MCP URL read it (src/lib/base-path.ts).
  env: { NEXT_PUBLIC_BASE_PATH: BASE_PATH },
};

export default nextConfig;
