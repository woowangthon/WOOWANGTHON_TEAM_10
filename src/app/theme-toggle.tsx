"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("mijuk-theme") === "dark";
    setDark(saved);
    document.documentElement.dataset.theme = saved ? "dark" : "light";
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    localStorage.setItem("mijuk-theme", next ? "dark" : "light");
  };
  return <button className="theme-toggle" type="button" onClick={toggle} aria-pressed={dark}>{dark ? "밝은 화면으로" : "어두운 화면으로"}</button>;
}
