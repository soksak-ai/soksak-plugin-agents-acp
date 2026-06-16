// soksak-plugin-acp-core — Agent Client Protocol(ACP) 클라이언트 엔진(라이브러리 플러그인).
//
// 역할: 어떤 ACP 에이전트(Gemini `gemini --acp`, Claude `npx @zed-industries/claude-code-acp`,
//   Codex …)든 코어 `process` capability 로 서브프로세스로 띄우고, stdio JSON-RPC(NDJSON)로
//   구조화 통신한다. 그 엔진을 sok 커맨드 + 이벤트로 노출 → 코크핏·라운지가 의존(app.commands.
//   execute + app.events)으로 소비한다. UI 없음(순수 공유 라이브러리). 락인 0 — ACP 표준만, 특정
//   에이전트 결합 0.
//
// 견고함 규율(claude-gui 계승): 전송≠수신(증거 전 인디케이터)·순차 턴 큐·stuck·NDJSON partial-frame
//   버퍼링·no-fake-progress·remount 생존. 깨지기 쉬운 정규식 스크래핑 대신 ACP 구조화 신호로 구현.
//
// [M0 스캐폴드] 적재/버전 확인 ping 만. ACP SDK 통합·멀티세션 채널·humanizer 는 다음 이정표.

export default {
  activate(ctx: any) {
    const app = ctx.app;
    if (app.commands?.register) {
      ctx.subscriptions.push(
        app.commands.register("ping", {
          description: "ACP 코어 적재/버전 확인(E2E)",
          handler: async () => ({
            ok: true,
            plugin: "soksak-plugin-acp-core",
            version: "0.1.0",
            phase: "M0",
          }),
        }),
      );
    }
  },
  deactivate() {},
};
