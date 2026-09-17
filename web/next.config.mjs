/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard imports the schemas and steam tables from ../src/shared rather than
  // redefining them: one definition of a telemetry frame, shared by producer and reader.
  experimental: { externalDir: true },
};
export default nextConfig;
