import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (.next/standalone).
  output: "standalone",
  agentRules: false,
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "bullmq", "ioredis"],
};

export default nextConfig;
