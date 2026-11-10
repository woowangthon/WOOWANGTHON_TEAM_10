import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "팀 기억 조언자", description: "팀의 메모를 참고하는 프로젝트 AI 대화" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* 테마를 첫 그리기 전에 적용한다 (data-theme 을 스크립트가 바꾸므로 html 의 속성 불일치 경고는 끈다) */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
