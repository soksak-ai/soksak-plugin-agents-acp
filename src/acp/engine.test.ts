// 에이전트-agnostic 런처 계약 고정 — preset(gemini/claude/codex)은 force-install 된 글로벌 bin 절대경로,
// npmBinDir 미해소 시 npx 폴백, 명시 cmd 우선. mock 은 preset 아님(테스트 fixture 는 명시 cmd 로). 락인 0 증명.
import { describe, it, expect } from "vitest";
import { resolveAgent, assistantText } from "./engine";

// agent_message_chunk 조립 — 델타 + 최종 완결 재전송 dedup(2배 중복 방지). canonical 재주입의 클린 전제.
const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { text } });
const usage = { sessionUpdate: "usage_update" };

describe("assistantText — 델타 조립 + 최종 완결 재전송 dedup", () => {
  it("델타 스트림 + 최종 완결 재전송 → 2배 아님(claude 어댑터 패턴)", () => {
    // [""] "H" "ELLO" "HELLO" — 마지막이 누적 전체("HELLO")와 동일 → 제거
    expect(assistantText([usage, chunk(""), chunk("H"), chunk("ELLO"), chunk("HELLO"), usage])).toBe("HELLO");
  });
  it("델타만(최종 재전송 없음) → 그대로 이음", () => {
    expect(assistantText([chunk("H"), chunk("ELLO")])).toBe("HELLO");
  });
  it("완결본 1개만 → 그대로", () => {
    expect(assistantText([chunk("HELLO")])).toBe("HELLO");
  });
  it("마지막이 누적과 다르면 보존(정상 델타 — 오인 제거 금지)", () => {
    expect(assistantText([chunk("AB"), chunk("CD")])).toBe("ABCD");
  });
  it("청크 없음 → 빈 문자열, 비-chunk update 무시", () => {
    expect(assistantText([usage, usage])).toBe("");
    expect(assistantText([])).toBe("");
  });
});

const DIR = "/plugins/acp-core";
const BIN = "/np/bin"; // 가짜 npm 글로벌 bin 디렉터리

describe("resolveAgent — 에이전트 무관 런처(락인 0)", () => {
  it("gemini = 글로벌 bin 절대경로 + --acp(구글 공식 CLI, ACP 네이티브)", () => {
    expect(resolveAgent({ agent: "gemini" }, DIR, BIN)).toEqual({
      cmd: `${BIN}/gemini`,
      args: ["--acp"],
      cwd: undefined,
    });
  });
  it("claude = 글로벌 bin claude-agent-acp(어댑터 — Opus 4.8)", () => {
    expect(resolveAgent({ agent: "claude" }, DIR, BIN)).toEqual({
      cmd: `${BIN}/claude-agent-acp`,
      args: [],
      cwd: undefined,
    });
  });
  it("codex = 글로벌 bin codex-acp(어댑터)", () => {
    expect(resolveAgent({ agent: "codex" }, DIR, BIN)).toEqual({
      cmd: `${BIN}/codex-acp`,
      args: [],
      cwd: undefined,
    });
  });
  it("npmBinDir 미해소 → npx 폴백(어댑터 자동 fetch — 마지막 안전망)", () => {
    expect(resolveAgent({ agent: "gemini" }, DIR)).toEqual({
      cmd: "npx",
      args: ["-y", "@google/gemini-cli@latest", "--acp"],
      cwd: undefined,
    });
    expect(resolveAgent({ agent: "claude" }, DIR)).toEqual({
      cmd: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@latest"],
      cwd: undefined,
    });
  });
  it("mock 은 더이상 preset 이 아님(테스트는 명시 cmd 로)", () => {
    expect(() => resolveAgent({ agent: "mock" }, DIR, BIN)).toThrow();
  });
  it("명시 cmd 는 preset 무시(임의 ACP 에이전트 — 테스트 목 포함)", () => {
    expect(resolveAgent({ cmd: "my-agent", args: ["--serve"], cwd: "/work" }, DIR, BIN)).toEqual({
      cmd: "my-agent",
      args: ["--serve"],
      cwd: "/work",
    });
  });
  it("cwd 전달", () => {
    expect(resolveAgent({ agent: "codex", cwd: "/repo" }, DIR, BIN).cwd).toBe("/repo");
  });
  it("알 수 없는 preset 은 에러(명시적 — 침묵 금지)", () => {
    expect(() => resolveAgent({ agent: "unknown-xyz" }, DIR, BIN)).toThrow();
    expect(() => resolveAgent({}, DIR, BIN)).toThrow();
  });
});
