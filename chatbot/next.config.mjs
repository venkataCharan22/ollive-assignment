/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@ollive/llm-sdk"],
  serverExternalPackages: ["@anthropic-ai/sdk", "openai", "@google/generative-ai"],
};

export default nextConfig;
