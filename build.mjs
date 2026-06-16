// soksak-plugin-acp-core 번들 빌드 — esbuild 단일 ESM main.js(로더가 blob-URL 로 import).
// 단일 파일·bare import 0 이 제약 → ACP TS SDK(@zed-industries/agent-client-protocol)도 번들 포함.
// 라이브러리 플러그인이라 UI/CSS/워커 없음 — ERD(3단계)보다 단순한 단일 엔트리 번들.
import { build, context } from "esbuild";

const opts = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm", // 로더가 dynamic import() 하는 ESM
  platform: "browser", // 플러그인은 webview 컨텍스트
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: "main.js",
  minify: false, // 가독(stale 검토). 발행 시 minify 전환.
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[acp-core] watching src → main.js …");
} else {
  await build(opts);
  console.log("[acp-core] built main.js");
}
