/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard imports the schemas and steam tables from ../src/shared rather than
  // redefining them: one definition of a telemetry frame, shared by producer and reader.
  experimental: { externalDir: true },
  // The Hiero SDK is server-only and does not survive bundling; the decision route
  // requires it at runtime instead.
  serverExternalPackages: ["@hiero-ledger/sdk"],
};
export default nextConfig;
