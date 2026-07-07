// soksak-plugin-agents-acp — Agent Client Protocol(ACP) 클라이언트 엔진(라이브러리 플러그인).
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

// ACP/JSON-RPC 에러는 message 에 모호한 "Internal error" 만 두고 진짜 원인은 data.details 에 싣는다
// (예: claude-agent-acp 의 "Invalid permissions.defaultMode: X"). details 를 표면화해 진단 가능하게.
function fmtErr(e: any): string {
  const base = String(e);
  const d = e?.data?.details ?? e?.details ?? e?.cause?.data?.details;
  return d && !base.includes(String(d)) ? `${base}: ${d}` : base;
}

export default {
  activate(ctx: any) {
    const app = ctx.app;
    const reg = app.commands?.register;
    if (!reg) return;

    ctx.subscriptions.push(
      app.commands.register("ping", {
        description: "Check that the ACP core plugin is loaded and return its version. Use for E2E health checks.",
        triggers: { ko: "ACP 코어 적재 버전 확인" },
        message: (d: any) => `ACP 코어 v${d.version}가 적재되었습니다.`,
        handler: async () => ({
          ok: true,
          plugin: "soksak-plugin-agents-acp",
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
          "Spawn an external program, send optional stdin, and collect stdout/stderr/exitCode. Primitive over the process capability. Use for arbitrary CLI integration or as a base for ACP agent launchers.",
        triggers: { ko: "외부 프로그램 실행 stdin stdout 수집" },
        message: (d: any) => `종료 코드 ${d.exitCode}로 실행을 마쳤습니다.`,
        params: {
          cmd: { type: "string", required: true, description: "Program to execute" },
          args: { type: "json", description: "Argument array (string[])" },
          stdin: { type: "string", description: "String to send to standard input (optional)" },
          cwd: { type: "string", description: "Working directory" },
          waitMs: { type: "number", description: "Maximum collection wait in ms (default 2000)" },
        },
        handler: async (p: any) => {
          const proc = app.process;
          if (!proc) return { ok: false, code: "NO_CAPABILITY", message: "process capability 없음(권한 미선언?)" };
          const args: string[] = Array.isArray(p.args) ? p.args : [];
          const waitMs: number = typeof p.waitMs === "number" ? p.waitMs : 2000;
          const dec = new TextDecoder();
          let out = "";
          let err = "";
          let handle: number;
          try {
            handle = await proc.spawn(p.cmd, args, { cwd: p.cwd });
          } catch (e) {
            return { ok: false, code: "SPAWN_FAILED", message: `spawn 실패: ${String(e)}` };
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
      triggers: { ko: string },
      params: any,
      handler: (p: any) => Promise<any>,
      message: (d: any) => string,
      hint?: (d: any) => { cmd: string; why: string }[],
    ) =>
      ctx.subscriptions.push(
        app.commands.register(name, { description, triggers, params, handler, message, ...(hint ? { hint } : {}) }),
      );

    addAcp(
      "connect",
      "Spawn an ACP agent process and complete the initialize handshake. Returns connId. Supply an agent preset (gemini/claude/codex) or an explicit cmd.",
      { ko: "ACP 에이전트 연결 초기화 핸드셰이크" },
      {
        agent: { type: "string", description: "Built-in preset: gemini|claude|codex" },
        cmd: { type: "string", description: "Explicit command to run (overrides preset)" },
        args: { type: "json", description: "Explicit argument array (string[])" },
        cwd: { type: "string", description: "Working directory" },
        permission: {
          type: "string",
          description: "Permission policy: deny (default, safe) | allow | ask (dependent plugin decides via bus)",
        },
      },
      async (p) => {
        try {
          return { ok: true, ...(await engine.connect(p)) };
        } catch (e) {
          return { ok: false, code: "INTERNAL", message: fmtErr(e) };
        }
      },
      (d: any) => `에이전트에 연결했습니다 (연결 ${d.connId}).`,
      (d: any) =>
        d.code
          ? []
          : [
              {
                cmd: `sok plugin.soksak-plugin-agents-acp.session-new {"connId":${d.connId}}`,
                why: "이 연결로 세션을 만들 수 있습니다.",
              },
            ],
    );
    addAcp(
      "session-new",
      "Create a new ACP session on a connection and return sessionId plus availableModels/modes. Optionally select a model via setSessionModel (e.g. claude: default/sonnet/haiku).",
      { ko: "ACP 세션 생성 연결 시작 모델 선택" },
      {
        connId: { type: "number", required: true },
        cwd: { type: "string" },
        model: { type: "string", description: "Model id (one of the adapter's availableModels)" },
      },
      async (p) => {
        try {
          return { ok: true, connId: p.connId, ...(await engine.sessionNew(p.connId, p.cwd, p.model)) };
        } catch (e) {
          return { ok: false, code: "INTERNAL", message: fmtErr(e) };
        }
      },
      (d: any) => `세션을 생성했습니다 (${d.sessionId}).`,
      (d: any) =>
        d.code
          ? []
          : [
              {
                cmd: `sok plugin.soksak-plugin-agents-acp.prompt {"connId":${d.connId},"sessionId":"${d.sessionId}","text":"..."}`,
                why: "이 세션에 프롬프트를 보낼 수 있습니다.",
              },
            ],
    );
    addAcp(
      "prompt",
      "Send a prompt to an ACP session. Collects session/update events during the turn and returns stopReason. Protected by sequential turn queue, stuck timeout, and agent-death detection.",
      { ko: "프롬프트 전송 턴 응답 수집 stopReason 반환" },
      {
        connId: { type: "number", required: true },
        sessionId: { type: "string", required: true },
        text: { type: "string", required: true },
        timeoutMs: { type: "number", description: "Stuck detection timeout in ms (default 60000)" },
      },
      async (p) => {
        try {
          return {
            ok: true,
            connId: p.connId,
            sessionId: p.sessionId,
            ...(await engine.prompt(p.connId, p.sessionId, p.text, { timeoutMs: p.timeoutMs })),
          };
        } catch (e) {
          return { ok: false, code: "INTERNAL", message: fmtErr(e) };
        }
      },
      (d: any) => `턴이 완료되었습니다 (${d.stopReason}).`,
      (d: any) =>
        d.code
          ? []
          : [
              {
                cmd: `sok plugin.soksak-plugin-agents-acp.prompt {"connId":${d.connId},"sessionId":"${d.sessionId}","text":"..."}`,
                why: "같은 세션에 이어서 프롬프트를 보낼 수 있습니다.",
              },
              {
                cmd: `sok plugin.soksak-plugin-agents-acp.disconnect {"connId":${d.connId}}`,
                why: "더 쓸 일이 없으면 연결을 종료할 수 있습니다.",
              },
            ],
    );
    addAcp(
      "cancel",
      "Cancel an in-progress turn by sending session/cancel to the agent.",
      { ko: "진행 중 턴 취소 세션 캔슬" },
      { connId: { type: "number", required: true }, sessionId: { type: "string", required: true } },
      async (p) => {
        try {
          await engine.cancel(p.connId, p.sessionId);
          return { ok: true, connId: p.connId, sessionId: p.sessionId };
        } catch (e) {
          return { ok: false, code: "INTERNAL", message: fmtErr(e) };
        }
      },
      () => "턴을 취소했습니다.",
      (d: any) =>
        d.code
          ? []
          : [
              {
                cmd: `sok plugin.soksak-plugin-agents-acp.prompt {"connId":${d.connId},"sessionId":"${d.sessionId}","text":"..."}`,
                why: "취소한 세션에 새 프롬프트를 보낼 수 있습니다.",
              },
            ],
    );
    addAcp(
      "disconnect",
      "Terminate an ACP connection and kill the agent subprocess.",
      { ko: "ACP 연결 종료 에이전트 종료" },
      { connId: { type: "number", required: true } },
      async (p) => {
        await engine.disconnect(p.connId);
        return { ok: true, connId: p.connId };
      },
      () => "연결을 종료했습니다.",
    );
    addAcp(
      "connections",
      "List all active ACP connections.",
      { ko: "활성 ACP 연결 목록 조회" },
      {},
      async () => ({ ok: true, connections: engine.list() }),
      (d: any) => `활성 연결 ${(d.connections ?? []).length}개.`,
    );
  },
  deactivate() {},
};
