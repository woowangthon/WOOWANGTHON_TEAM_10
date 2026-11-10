// 저장해 둔 화면 테마를 첫 그리기 전에 적용한다. 모든 화면(로그인·팀 목록 포함)에서 같은 테마가 유지되고, 어두운 화면이 밝게 깜빡이지 않는다.
// CSP(script-src 'self')를 지키려고 인라인 스크립트가 아니라 같은 출처의 파일로 둔다.
try {
  document.documentElement.dataset.theme = localStorage.getItem("mijuk-theme") === "dark" ? "dark" : "light";
} catch (e) {
  // 저장소를 못 쓰는 브라우저 설정이면 기본(밝은) 화면으로 둔다
}
