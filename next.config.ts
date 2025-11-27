import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "ALLOWALL",
          },
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://unsw.au1.qualtrics.com https://*.qualtrics.com https://*.qualtrics.com.au",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
