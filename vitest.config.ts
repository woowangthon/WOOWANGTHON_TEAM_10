import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // 테스트들이 같은 DB를 쓰므로 순차 실행
    testTimeout: 20000,
  },
});
