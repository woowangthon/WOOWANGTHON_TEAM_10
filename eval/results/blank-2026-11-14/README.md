# 처음 보는 시나리오 검증 (2026-11-14)

다른 팀원의 「AI만 참고」 메모가, 그 내용을 말한 적 없는 질문자의 답변에 뜬금없이 나타나는지를 실제 모델로 확인한 기록이다. 설명은 `docs/평가_보고서.md` §25에 있다.

- `blank.mjs`, `blank2.mjs`, `blank3.mjs`(+`set3.json`): 시나리오와 실행기. 세 사람이 「AI만 참고」 메모를 남기고, 메모가 없는 네 번째 사람(관찰자)과 메모를 쓴 두 사람이 질문한다. `node blank3.mjs <서버 주소> <out.json> 0,1,2`
- `judge.ts`: 어느 서버의 답변인지 모르는 채로 판정하는 AI 판정자. `node --experimental-transform-types judge.ts in.json out.json`
- `base-N.judged.json`: 고치기 전 코드(main `0d76032`)의 답변과 판정. `new-N*.judged.json`: 고친 코드의 답변과 판정(`c`·`d`가 최종 지시문).

모두 가상 자료다. 가입이 한 시간에 20회로 제한되므로 시나리오 세 개마다 서버를 다시 띄웠다.
