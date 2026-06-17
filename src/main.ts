// soksak-plugin-acp-core — Agent Client Protocol(ACP) 클라이언트 엔진(라이브러리 플러그인).
//
// 역할: 어떤 ACP 에이전트(Gemini `gemini --acp`, Claude `npx @agentclientprotocol/claude-agent-acp`,
//   Codex …)든 코어 `process` capability 로 서브프로세스로 띄우고, stdio JSON-RPC(NDJSON)로
//   구조화 통신한다. 그 엔진을 sok 커맨드 + 이벤트로 노출 → 의존 플러그인이 app.commands.execute +
//   app.events 로 소비한다. UI 없음(순수 공유 라이브러리). ACP 표준만 따르므로 특정 에이전트에 안 묶인다.
//
// 견고함 규율(claude-gui 계승): 전송≠수신(증거 전 인디케이터)·순차 턴 큐·stuck·NDJSON partial-frame
//   버퍼링·no-fake-progress·remount 생존. 깨지기 쉬운 정규식 스크래핑 대신 ACP 구조화 신호로 구현.
//
// [M1] ACP 엔진(connect/session/prompt) 추가. 멀티세션 채널·견고함 규율·humanizer 는 다음 이정표.

import { createAcpEngine } from "./acp/engine";

export default {
  activate(ctx: any) {
    const app = ctx.app;
    const reg = app.commands?.register;
    if (!reg) return;

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

    // 외부 프로그램 실행(범용 primitive) — process capability 위에. ACP 에이전트 런처의 기반이자
    // 임의 CLI 통합용. stdin 보내고 stdout/stderr/exit 수집. 종료(onExit) 또는 waitMs 안전바운드까지
    // 수집(이벤트 기반 — 폴링 아님; 비종료 프로그램은 waitMs 후 kill). process 권한 한정.
    ctx.subscriptions.push(
      app.commands.register("exec", {
        description:
          "외부 프로그램 실행 — stdin 보내고 stdout/stderr/exit 수집(process capability primitive·E2E)",
        params: {
          cmd: { type: "string", required: true, description: "실행할 프로그램" },
          args: { type: "json", description: "인자 배열(string[])" },
          stdin: { type: "string", description: "표준입력으로 보낼 문자열(생략 가능)" },
          cwd: { type: "string", description: "작업 디렉토리" },
          waitMs: { type: "number", description: "수집 최대 대기(ms, 기본 2000)" },
        },
        handler: async (p: any) => {
          const proc = app.process;
          if (!proc) return { ok: false, error: "process capability 없음(권한 미선언?)" };
          const args: string[] = Array.isArray(p.args) ? p.args : [];
          const waitMs: number = typeof p.waitMs === "number" ? p.waitMs : 2000;
          const dec = new TextDecoder();
          let out = "";
          let err = "";
          let handle: number;
          try {
            handle = await proc.spawn(p.cmd, args, { cwd: p.cwd });
          } catch (e) {
            return { ok: false, error: `spawn 실패: ${String(e)}` };
          }
          proc.onData(handle, (b: Uint8Array) => {
            out += dec.decode(b, { stream: true });
          });
          proc.onStderr(handle, (b: Uint8Array) => {
            err += dec.decode(b, { stream: true });
          });
          if (typeof p.stdin === "string") await proc.write(handle, p.stdin);
          // 종료 또는 waitMs(안전바운드) — 이벤트(onExit) 기반, 타임아웃은 비종료 프로그램 대비.
          const exitCode: number | null = await new Promise((resolve) => {
            let settled = false;
            const done = (code: number | null) => {
              if (settled) return;
              settled = true;
              resolve(code);
            };
            proc.onExit(handle, (code: number) => done(code));
            setTimeout(() => {
              proc.kill(handle);
              done(null);
            }, waitMs);
          });
          return { ok: true, stdout: out, stderr: err, exitCode };
        },
      }),
    );

    // ── ACP 엔진 — process capability 위에 ACP 클라이언트(어떤 ACP 에이전트든). 락인 0. ──
    const engine = createAcpEngine(app, ctx.dir);
    const addAcp = (
      name: string,
      description: string,
      params: any,
      handler: (p: any) => Promise<any>,
    ) => ctx.subscriptions.push(app.commands.register(name, { description, params, handler }));

    addAcp(
      "connect",
      "ACP 에이전트 연결(spawn + initialize 핸드셰이크) → connId. agent preset(gemini/claude/codex) 또는 cmd 지정",
      {
        agent: { type: "string", description: "preset: gemini|claude|codex" },
        cmd: { type: "string", description: "명시 실행 명령(preset 대신)" },
        args: { type: "json", description: "명시 인자(string[])" },
        cwd: { type: "string", description: "작업 디렉토리" },
        permission: {
          type: "string",
          description: "권한 정책: deny(기본·안전)|allow|ask(의존 플러그인이 버스로 결정)",
        },
      },
      async (p) => {
        try {
          return { ok: true, ...(await engine.connect(p)) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    );
    addAcp(
      "session-new",
      "새 ACP 세션 → sessionId + availableModels/modes. model 지정 시 setSessionModel(claude: default/sonnet/haiku)",
      {
        connId: { type: "number", required: true },
        cwd: { type: "string" },
        model: { type: "string", description: "모델 id(어댑터 availableModels 중 하나)" },
      },
      async (p) => {
        try {
          return { ok: true, ...(await engine.sessionNew(p.connId, p.cwd, p.model)) };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    );
    addAcp(
      "prompt",
      "프롬프트 전송 — 턴 동안 session/update 수집 후 stopReason 반환(순차 큐·stuck timeout·death 보호)",
      {
        connId: { type: "number", required: true },
        sessionId: { type: "string", required: true },
        text: { type: "string", required: true },
        timeoutMs: { type: "number", description: "stuck 판정 타임아웃(기본 60000)" },
      },
      async (p) => {
        try {
          return {
            ok: true,
            ...(await engine.prompt(p.connId, p.sessionId, p.text, { timeoutMs: p.timeoutMs })),
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    );
    addAcp(
      "cancel",
      "진행 중 턴 취소(session/cancel)",
      { connId: { type: "number", required: true }, sessionId: { type: "string", required: true } },
      async (p) => {
        try {
          await engine.cancel(p.connId, p.sessionId);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
    );
    addAcp(
      "disconnect",
      "연결 종료(에이전트 kill)",
      { connId: { type: "number", required: true } },
      async (p) => {
        await engine.disconnect(p.connId);
        return { ok: true };
      },
    );
    addAcp("connections", "활성 연결 목록", {}, async () => ({
      ok: true,
      connections: engine.list(),
    }));
  },
  deactivate() {},
};
