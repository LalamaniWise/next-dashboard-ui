/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ hostname: "images.pexels.com" }],
  },
  // Read from disk when covers and PDFs are drawn. Listed so hosts that only
  // ship the files each route uses (like Vercel) include them.
  outputFileTracingIncludes: {
    "/**": ["./assets/fonts/*.otf", "./public/logo.png"],
  },
  // Basic hardening: no embedding in other sites' frames (clickjacking), no
  // content-type guessing, and no leaking full URLs to other sites
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
