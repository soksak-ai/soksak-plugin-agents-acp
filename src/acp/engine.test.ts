// 에이전트-agnostic 런처 계약 고정 — preset(mock/gemini/claude/codex)·명시 cmd·미지정. 락인 0 증명.
import { describe, it, expect } from "vitest";
import { resolveAgent } from "./engine";

const DIR = "/plugins/acp-core";

describe("resolveAgent — 에이전트 무관 런처(락인 0)", () => {
  it("mock = 번들 목 스크립트", () => {
    expect(resolveAgent({ agent: "mock" }, DIR)).toEqual({
      cmd: "node",
      args: [`${DIR}/scripts/mock-acp-agent.mjs`],
      cwd: undefined,
    });
  });
  it("gemini = gemini --acp", () => {
    expect(resolveAgent({ agent: "gemini" }, DIR)).toEqual({ cmd: "gemini", args: ["--acp"], cwd: undefined });
  });
  it("claude = npx @agentclientprotocol/claude-agent-acp (최신 — Opus 4.8)", () => {
    expect(resolveAgent({ agent: "claude" }, DIR)).toEqual({
      cmd: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@latest"],
      cwd: undefined,
    });
  });
  it("codex = npx @agentclientprotocol/codex-acp (최신)", () => {
    expect(resolveAgent({ agent: "codex" }, DIR)).toEqual({
      cmd: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@latest"],
      cwd: undefined,
    });
  });
  it("명시 cmd 는 preset 무시(임의 ACP 에이전트)", () => {
    expect(resolveAgent({ cmd: "my-agent", args: ["--serve"], cwd: "/work" }, DIR)).toEqual({
      cmd: "my-agent",
      args: ["--serve"],
      cwd: "/work",
    });
  });
  it("cwd 전달", () => {
    expect(resolveAgent({ agent: "codex", cwd: "/repo" }, DIR).cwd).toBe("/repo");
  });
  it("알 수 없는 preset 은 에러(명시적 — 침묵 금지)", () => {
    expect(() => resolveAgent({ agent: "unknown-xyz" }, DIR)).toThrow();
    expect(() => resolveAgent({}, DIR)).toThrow();
  });
});
