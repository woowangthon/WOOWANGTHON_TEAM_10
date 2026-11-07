import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "팀 기억 조언자", description: "팀의 메모를 참고하는 프로젝트 AI 대화" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
