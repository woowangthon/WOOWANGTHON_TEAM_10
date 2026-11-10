"use client";
// 가운데 목록(details.pane-picker)을 넓은 화면에서는 항상 펼치고, 휴대폰에서는 접었다 펴게 한다.
// 넓은 화면에서 목록을 보이게 하는 CSS(::details-content)는 최신 브라우저에만 있어서, 지원하지 않는 브라우저에서는
// 접힌 목록을 펼 방법이 없다. 그래서 넓은 화면에서는 open 속성도 직접 켠다.
import { useEffect, useRef } from "react";

const MOBILE = "(max-width: 760px)";

export function usePanePicker() {
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const query = window.matchMedia(MOBILE);
    const sync = () => { if (picker.current) picker.current.open = !query.matches; };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  /** 목록에서 항목을 고른 뒤: 휴대폰에서만 목록을 접어 본문이 보이게 한다 */
  const closeOnMobile = () => {
    if (picker.current && window.matchMedia(MOBILE).matches) picker.current.open = false;
  };
  return { picker, closeOnMobile };
}
