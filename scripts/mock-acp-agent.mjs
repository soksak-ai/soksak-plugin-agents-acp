#!/usr/bin/env node
// Mock ACP 에이전트 — 테스트 fixture(결정적·외부 의존 0). SDK AgentSideConnection 으로 최소 ACP 구현.
// acp-core 엔진의 핸드셰이크·prompt·session/update 경로를 실 에이전트 없이 RED→GREEN 검증한다.
// 동작: initialize → newSession → prompt 시 agent_message_chunk + tool_call(pending→completed) 를
// emit 하고 end_turn. 프롬프트에 "readfile:<path>" 가 있으면 client 의 fs/read 를 호출(브리지 검증).
import * as acp from "@zed-industries/agent-client-protocol";
import { Writable, Readable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout), // 우리가 쓰는 곳(→ client 가 읽음)
  Readable.toWeb(process.stdin), // 우리가 읽는 곳(← client 가 씀)
);

let conn;
const agent = {
  async initialize(_params) {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
  },
  async newSession(_params) {
    return { sessionId: "mock-session-1" };
  },
  async authenticate() {
    return {};
  },
  async prompt(params) {
    const sessionId = params.sessionId;
    const userText = (params.prompt || [])
      .map((b) => (b && b.type === "text" ? b.text : ""))
      .join("");

    // (옵션) fs 브리지 검증 — client 가 광고한 fs.readTextFile 호출.
    const m = /readfile:(\S+)/.exec(userText);
    if (m && conn.readTextFile) {
      try {
        const r = await conn.readTextFile({ sessionId, path: m[1] });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `file(${m[1]})=${(r.content || "").slice(0, 40)}` },
          },
        });
      } catch (e) {
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fs-error:${String(e)}` } },
        });
      }
    }

    // 메시지 청크
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${userText}` } },
    });
    // 툴콜 pending → completed
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "mock tool", kind: "other", status: "pending" },
    });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    });
    return { stopReason: "end_turn" };
  },
  async cancel(_params) {
    return {};
  },
};

conn = new acp.AgentSideConnection((_client) => agent, stream);
