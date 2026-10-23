import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Basic security headers on every page. No CSP yet: it would need tuning for the LiqPay form POST,
  // Next.js inline scripts and fonts. HSTS is already set by Vercel
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },

  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:3001"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
