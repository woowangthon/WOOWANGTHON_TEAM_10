import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// 콘텐츠 보안 정책(CSP): 이 사이트 밖에서 스크립트·데이터를 끌어오지 못하게 한다.
// Next.js 가 넣는 인라인 스크립트 때문에 'unsafe-inline' 은 허용한다(nonce 방식은 모든 페이지를 동적 렌더링으로 바꿔야 해서 보류).
// 개발 서버는 핫리로드에 eval 과 웹소켓을 쓰므로 운영 빌드에만 적용한다.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd
    ? [
        { key: "Content-Security-Policy", value: csp },
        // HTTPS 로만 접속하게 한다 (HTTPS 응답에서만 효력이 있음)
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      ]
    : []),
];

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
