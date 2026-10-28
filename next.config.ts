import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root so a stray parent lockfile can't be picked up.
  turbopack: { root: path.join(__dirname) },
  // Every page is per-request and session-dependent (staff CRUD), so Cache
  // Components / partial prerendering add no value here and are left off.
  cacheComponents: false,
  // pg is a Node-only dependency; keep it out of the bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
