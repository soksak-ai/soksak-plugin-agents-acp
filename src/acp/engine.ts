// ACP 엔진 — Agent Client Protocol 클라이언트. 어떤 ACP 에이전트든 코어 `process` capability 로
// 띄우고 stdio JSON-RPC 로 통신한다. 락인 0(ACP 표준만, 에이전트는 launch 명령만 다름).
//
// transport: soksak `app.process`(onData/write) ↔ web ReadableStream/WritableStream → SDK ndJsonStream.
// 핸들러: sessionUpdate(에이전트→client 알림) 수집, fs/read·write → app.fs 브리지, permission(M1 stub).
//
// [M1] connect(핸드셰이크 initialize) → session-new → prompt(턴 동안 session/update 수집) → stopReason.
//   견고함 규율(전송≠수신 인디케이터·순차 턴 큐·stuck)·멀티세션 채널·streaming 이벤트는 M2.

import * as acp from "@zed-industries/agent-client-protocol";

export interface AgentLaunch {
  cmd: string;
  args: string[];
  cwd?: string;
}

// agnostic 런처 — preset 또는 명시 cmd/args. preset 은 launch 명령만 다르고 코드는 하나(락인 0).
export function resolveAgent(
  opts: { agent?: string; cmd?: string; args?: string[]; cwd?: string },
  pluginDir: string,
): AgentLaunch {
  if (opts.cmd) return { cmd: opts.cmd, args: opts.args ?? [], cwd: opts.cwd };
  // preset = 편의 launch 문자열일 뿐(락인 0 — 코드는 하나, 차이는 명령뿐). 임의 ACP 에이전트는 cmd 로.
  //  mock: 결정적 테스트 fixture(SDK AgentSideConnection).
  //  claude: @zed-industries/claude-code-acp — 실 검증됨(initialize→session→prompt→end_turn GREEN).
  //  gemini: Gemini CLI 의 ACP 모드(gemini --acp).
  //  codex: 전방 placeholder — codex 0.140 은 ACP 미지원(MCP=`codex mcp-server` 만 노출). codex 가
  //    ACP 를 추가하면 활성화. 그 전까지 선택 시 명확히 실패(stuck timeout) — 침묵 오작동 아님.
  const presets: Record<string, { cmd: string; args: string[] }> = {
    mock: { cmd: "node", args: [`${pluginDir}/scripts/mock-acp-agent.mjs`] },
    gemini: { cmd: "gemini", args: ["--acp"] },
    claude: { cmd: "npx", args: ["@zed-industries/claude-code-acp"] },
    codex: { cmd: "codex", args: ["acp"] },
  };
  const p = presets[opts.agent ?? ""];
  if (!p) throw new Error(`알 수 없는 에이전트: ${opts.agent} (preset: ${Object.keys(presets).join("/")} 또는 cmd 지정)`);
  return { cmd: p.cmd, args: p.args, cwd: opts.cwd };
}

// soksak app.process(handle) → SDK Stream(ndJsonStream). 쓰기=process.write, 읽기=process.onData.
function makeStream(app: any, handle: number): acp.Stream {
  const dec = new TextDecoder();
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // SDK 가 인코딩한 NDJSON 바이트 → 문자열로 디코드해 stdin 으로(UTF-8 라운드트립).
      return app.process.write(handle, dec.decode(chunk));
    },
  });
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  // onData 등록 전 도착분은 app.process 가 버퍼(유실 0) → 등록 시 즉시 replay.
  app.process.onData(handle, (b: Uint8Array) => {
    try {
      ctrl?.enqueue(b);
    } catch {
      /* 닫힌 뒤 도착 — 무시 */
    }
  });
  app.process.onExit(handle, () => {
    try {
      ctrl?.close();
    } catch {
      /* 이미 닫힘 */
    }
  });
  return acp.ndJsonStream(writable, readable);
}

type PermissionPolicy = "allow" | "deny" | "ask";

interface Conn {
  id: number;
  handle: number;
  conn: acp.ClientSideConnection;
  collectors: Map<string, any[]>; // sessionId → 진행 중 턴의 session/update 수집
  stderr: string;
  exited: boolean;
  permission: PermissionPolicy; // 권한 요청 정책(기본 deny — 안전). ask=의존 플러그인이 버스로 결정.
  queues: Map<string, Promise<unknown>>; // sessionId → 순차 턴 tail(단일 in-flight, claude-gui 규율)
  deathWaiters: Set<() => void>; // 프로세스 death 시 깨울 in-flight 대기자(무한대기 금지)
  permSeq: number;
}

export function createAcpEngine(app: any, pluginDir: string) {
  const connections = new Map<number, Conn>();
  let nextId = 1;

  async function connect(opts: {
    agent?: string;
    cmd?: string;
    args?: string[];
    cwd?: string;
    permission?: PermissionPolicy;
  }): Promise<{ connId: number }> {
    if (!app.process) throw new Error("process capability 없음(권한 미선언?)");
    const launch = resolveAgent(opts, pluginDir);
    // ACP 자식 에이전트 = 에디터가 띄운 독립 세션. 호스트의 Claude Code 중첩 가드(CLAUDECODE 등)를
    // 떼어내 claude 어댑터가 "nested session" 으로 오인해 막히지 않게 한다(soksak 을 Claude Code 안에서
    // 띄운 경우 대비). 타 에이전트(gemini/codex/…)엔 무해 — 해당 키를 안 쓰므로.
    const handle = await app.process.spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      envRemove: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
    });
    const id = nextId++;
    const collectors = new Map<string, any[]>();
    const rec: Conn = {
      id,
      handle,
      conn: null as any,
      collectors,
      stderr: "",
      exited: false,
      permission: opts.permission ?? "deny",
      queues: new Map(),
      deathWaiters: new Set(),
      permSeq: 0,
    };
    const dec = new TextDecoder();
    app.process.onStderr(handle, (b: Uint8Array) => {
      rec.stderr += dec.decode(b, { stream: true });
    });
    app.process.onExit(handle, () => {
      rec.exited = true;
      // in-flight 턴 전부 깨운다(무한대기 금지 — claude-gui 규율: 프로세스 death → 즉시 실패 표시).
      for (const w of rec.deathWaiters) {
        try {
          w();
        } catch {
          /* noop */
        }
      }
      rec.deathWaiters.clear();
    });

    const client: acp.Client = {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const arr = collectors.get(params.sessionId);
        if (arr) arr.push(params.update);
        // 스트리밍 — 의존 플러그인(코크핏/라운지)이 `acp.update.<connId>` 구독해 라이브 렌더.
        // collect(prompt 반환값)와 별개 채널(둘 다: 헤드리스는 반환, UI 는 스트리밍).
        app.bus?.emit(`acp.update.${id}`, {
          connId: id,
          sessionId: params.sessionId,
          update: params.update,
        });
      },
      async requestPermission(params: any): Promise<any> {
        // 구조화 권한 — 정규식 모달 감지 불요(ACP 가 구조로 줌). 정책:
        //  deny(기본·안전): 취소. allow: 첫 allow-류 옵션 선택. ask: 의존 플러그인이 버스로 결정.
        const opts: any[] = params?.options ?? [];
        const cancelled = { outcome: { outcome: "cancelled" } };
        if (rec.permission === "deny") return cancelled;
        if (rec.permission === "allow") {
          // allow_once|allow_always 우선, 없으면 첫 옵션. 거부 류는 피한다.
          const pick =
            opts.find((o) => /allow|grant|accept|approve/i.test(o.kind ?? o.optionId ?? "")) ??
            opts.find((o) => !/reject|deny|cancel/i.test(o.kind ?? o.optionId ?? "")) ??
            opts[0];
          return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : cancelled;
        }
        // ask — acp.permission.<connId> 로 요청 emit, 의존 플러그인이 response 채널로 결정. 무응답=거부.
        const reqId = `${id}-${rec.permSeq++}`;
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (outcome: any) => {
            if (settled) return;
            settled = true;
            off();
            clearTimeout(timer);
            resolve(outcome);
          };
          const off =
            app.bus?.on(`acp.permission.response.${id}`, (resp: any) => {
              if (resp?.reqId === reqId) finish(resp.outcome ?? cancelled);
            }) ?? (() => {});
          app.bus?.emit(`acp.permission.${id}`, { connId: id, reqId, request: params });
          // 안전 기본 — 30초 무응답이면 거부(stuck 권한이 턴을 영구 점유하지 않게).
          const timer = setTimeout(() => finish(cancelled), 30000);
        });
      },
      async readTextFile(params: any): Promise<any> {
        if (!app.fs?.readText) throw new Error("fs:read 권한 없음");
        const r = await app.fs.readText(params.path);
        return { content: typeof r === "string" ? r : r.text ?? "" };
      },
      async writeTextFile(params: any): Promise<any> {
        if (!app.fs?.writeText) throw new Error("fs:write 권한 없음");
        await app.fs.writeText(params.path, params.content);
        return {};
      },
    };

    const stream = makeStream(app, handle);
    const c = new acp.ClientSideConnection((_agent) => client, stream);
    rec.conn = c;
    await c.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    } as any);
    connections.set(id, rec);
    return { connId: id };
  }

  function get(connId: number): Conn {
    const c = connections.get(connId);
    if (!c) throw new Error(`연결 없음: ${connId}`);
    return c;
  }

  async function sessionNew(connId: number, cwd?: string): Promise<{ sessionId: string }> {
    const c = get(connId);
    const r = await c.conn.newSession({ cwd: cwd ?? "/", mcpServers: [] } as any);
    return { sessionId: r.sessionId };
  }

  // 한 턴 실행 — 수집기 설치 → prompt(stuck timeout/death 와 race) → 정리. queue 가 직렬화 보장.
  async function runTurn(
    c: Conn,
    sessionId: string,
    text: string,
    timeoutMs: number,
  ): Promise<{ stopReason: string; updates: any[]; stderr?: string }> {
    if (c.exited) throw new Error("에이전트 종료됨(연결 죽음) — 프롬프트 불가");
    const updates: any[] = [];
    c.collectors.set(sessionId, updates);
    try {
      const r = await raceTurn(c, sessionId, text, timeoutMs);
      return { stopReason: r.stopReason, updates, stderr: c.stderr || undefined };
    } finally {
      c.collectors.delete(sessionId);
    }
  }

  // prompt 응답을 stuck timeout·프로세스 death 와 race. 둘 중 먼저면 취소/실패(무한대기 금지).
  function raceTurn(c: Conn, sessionId: string, text: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        c.deathWaiters.delete(onDeath);
      };
      const done = (fn: (v: any) => void, v: any) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(v);
      };
      const onDeath = () =>
        done(reject, new Error("에이전트 종료됨(턴 중 프로세스 death) — in-flight 실패 처리"));
      c.deathWaiters.add(onDeath);
      const timer = setTimeout(() => {
        // stuck — 취소 시도 후 거부. 첫 update/응답이 안 오면 무한대기 대신 실패로.
        c.conn.cancel({ sessionId } as any).catch(() => {});
        done(reject, new Error(`응답 지연(stuck) — ${timeoutMs}ms 내 미완료, 취소함`));
      }, timeoutMs);
      c.conn.prompt({ sessionId, prompt: [{ type: "text", text }] } as any).then(
        (v) => done(resolve, v),
        (e) => done(reject, e),
      );
    });
  }

  async function prompt(
    connId: number,
    sessionId: string,
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ stopReason: string; updates: any[]; stderr?: string }> {
    const c = get(connId);
    const timeoutMs = opts?.timeoutMs ?? 60000;
    // 순차 턴 큐 — 같은 세션의 prompt 는 직렬화(단일 in-flight). 이전 턴 tail 완료 후 시작(수집기
    // 충돌 0, request↔응답 정확 매칭). claude-gui 의 single-injecting 대응.
    const prev = c.queues.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => runTurn(c, sessionId, text, timeoutMs));
    c.queues.set(sessionId, run.catch(() => {}));
    return run;
  }

  async function cancel(connId: number, sessionId: string): Promise<void> {
    const c = get(connId);
    await c.conn.cancel({ sessionId } as any);
  }

  async function disconnect(connId: number): Promise<void> {
    const c = connections.get(connId);
    if (!c) return;
    try {
      await app.process.kill(c.handle);
    } catch {
      /* 이미 죽음 */
    }
    connections.delete(connId);
  }

  function list(): { connId: number; handle: number; exited: boolean }[] {
    return [...connections.values()].map((c) => ({ connId: c.id, handle: c.handle, exited: c.exited }));
  }

  return { connect, sessionNew, prompt, cancel, disconnect, list };
}
