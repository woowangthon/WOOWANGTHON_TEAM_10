import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "팀 기억 조언자", description: "팀원의 미완성 생각을 작업 조언으로 연결" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
