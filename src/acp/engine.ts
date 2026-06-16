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

interface Conn {
  id: number;
  handle: number;
  conn: acp.ClientSideConnection;
  collectors: Map<string, any[]>; // sessionId → 진행 중 턴의 session/update 수집
  stderr: string;
  exited: boolean;
}

export function createAcpEngine(app: any, pluginDir: string) {
  const connections = new Map<number, Conn>();
  let nextId = 1;

  async function connect(opts: {
    agent?: string;
    cmd?: string;
    args?: string[];
    cwd?: string;
  }): Promise<{ connId: number }> {
    if (!app.process) throw new Error("process capability 없음(권한 미선언?)");
    const launch = resolveAgent(opts, pluginDir);
    const handle = await app.process.spawn(launch.cmd, launch.args, { cwd: launch.cwd });
    const id = nextId++;
    const collectors = new Map<string, any[]>();
    const rec: Conn = { id, handle, conn: null as any, collectors, stderr: "", exited: false };
    const dec = new TextDecoder();
    app.process.onStderr(handle, (b: Uint8Array) => {
      rec.stderr += dec.decode(b, { stream: true });
    });
    app.process.onExit(handle, () => {
      rec.exited = true;
    });

    const client: acp.Client = {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        const arr = collectors.get(params.sessionId);
        if (arr) arr.push(params.update);
      },
      async requestPermission(params: any): Promise<any> {
        // M1 stub — 안전 기본(취소). 실제 정책은 dependent 플러그인(코크핏/라운지)이 M2 에서 결정.
        return { outcome: { outcome: "cancelled" } };
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

  async function prompt(
    connId: number,
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string; updates: any[]; stderr?: string }> {
    const c = get(connId);
    const updates: any[] = [];
    c.collectors.set(sessionId, updates);
    try {
      const r = await c.conn.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      } as any);
      return { stopReason: r.stopReason, updates, stderr: c.stderr || undefined };
    } finally {
      c.collectors.delete(sessionId);
    }
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
