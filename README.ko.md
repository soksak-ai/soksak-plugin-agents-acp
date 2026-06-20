# soksak-plugin-agents-acp

soksak에서 AI 코딩 에이전트를 다루는 라이브러리 플러그인. 화면(UI)은 없다.

Claude·Codex·Gemini 같은 AI 에이전트를 서브프로세스로 실행하고, 표준 프로토콜인 ACP(Agent Client
Protocol, 에디터와 AI 코딩 에이전트 사이의 통신 규약)로 주고받는다. 이 기능을 커맨드와 이벤트로 노출한다.

## 커맨드

| 커맨드 | 설명 |
|--------|------|
| `connect` | 에이전트 실행 + 연결 (preset: claude·codex·gemini, 또는 직접 실행 명령) |
| `session-new` | 새 대화 세션 |
| `prompt` | 프롬프트 전송 후 응답 수집 |
| `cancel` / `disconnect` / `connections` | 턴 취소 / 연결 종료 / 연결 목록 |

응답 조각은 `acp.update.<연결id>` 이벤트로도 흘러나오므로, 구독하면 실시간 렌더에 쓸 수 있다.

## 에이전트 CLI

각 에이전트는 자기 CLI가 필요하다. 이 CLI들은 매니페스트의 `libraries`로 선언되어, 플러그인을 켤 때
없으면 강제 설치된다(동의 화면에 설치 명령 그대로 표기). 설치된 글로벌 bin을 절대경로로 실행하므로 PATH에
묶이지 않는다.

| 에이전트 | CLI | 비고 |
|----------|-----|------|
| claude | `@agentclientprotocol/claude-agent-acp` | 공식 CLI가 ACP 미지원이라 어댑터 |
| codex | `@agentclientprotocol/codex-acp` | codex CLI(ChatGPT)를 ACP로 브리지 |
| gemini | `@google/gemini-cli` | 구글 공식 CLI가 ACP 네이티브 지원(`--acp`) |

각 에이전트의 로그인/인증은 해당 CLI 쪽에서 한다(claude=Claude 계정, codex=ChatGPT, gemini=Google).

## 빌드

```
npm install
npm run build   # esbuild → main.js (ACP SDK 포함)
npm test
```

설치는 clone만 하면 된다(빌드된 main.js를 추적, 별도 빌드 스텝 없음).

## 의존

- soksak `process` capability — 서브프로세스 실행 + 양방향 stdio.
- `@agentclientprotocol/sdk` — ACP TypeScript SDK. 에이전트 어댑터는 `@agentclientprotocol/*` 최신 버전.
