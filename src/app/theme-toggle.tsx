"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    // 테마 적용은 public/theme-init.js 가 첫 그리기 전에 한다. 여기서는 버튼 표시만 맞춘다.
    let saved = false;
    try { saved = localStorage.getItem("mijuk-theme") === "dark"; } catch { /* 저장소를 못 쓰면 밝은 화면 */ }
    setDark(saved);
    document.documentElement.dataset.theme = saved ? "dark" : "light";
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try { localStorage.setItem("mijuk-theme", next ? "dark" : "light"); } catch { /* 저장하지 못해도 이번 화면에는 적용된다 */ }
  };
  return <button className="theme-toggle" type="button" onClick={toggle} aria-pressed={dark}>{dark ? "밝은 화면으로" : "어두운 화면으로"}</button>;
}
