// src/main.ts
var main_default = {
  activate(ctx) {
    const app = ctx.app;
    const reg = app.commands?.register;
    if (!reg) return;
    ctx.subscriptions.push(
      app.commands.register("ping", {
        description: "ACP \uCF54\uC5B4 \uC801\uC7AC/\uBC84\uC804 \uD655\uC778(E2E)",
        handler: async () => ({
          ok: true,
          plugin: "soksak-plugin-acp-core",
          version: "0.1.0",
          phase: "M0"
        })
      })
    );
    ctx.subscriptions.push(
      app.commands.register("exec", {
        description: "\uC678\uBD80 \uD504\uB85C\uADF8\uB7A8 \uC2E4\uD589 \u2014 stdin \uBCF4\uB0B4\uACE0 stdout/stderr/exit \uC218\uC9D1(process capability primitive\xB7E2E)",
        params: {
          cmd: { type: "string", required: true, description: "\uC2E4\uD589\uD560 \uD504\uB85C\uADF8\uB7A8" },
          args: { type: "json", description: "\uC778\uC790 \uBC30\uC5F4(string[])" },
          stdin: { type: "string", description: "\uD45C\uC900\uC785\uB825\uC73C\uB85C \uBCF4\uB0BC \uBB38\uC790\uC5F4(\uC0DD\uB7B5 \uAC00\uB2A5)" },
          cwd: { type: "string", description: "\uC791\uC5C5 \uB514\uB809\uD1A0\uB9AC" },
          waitMs: { type: "number", description: "\uC218\uC9D1 \uCD5C\uB300 \uB300\uAE30(ms, \uAE30\uBCF8 2000)" }
        },
        handler: async (p) => {
          const proc = app.process;
          if (!proc) return { ok: false, error: "process capability \uC5C6\uC74C(\uAD8C\uD55C \uBBF8\uC120\uC5B8?)" };
          const args = Array.isArray(p.args) ? p.args : [];
          const waitMs = typeof p.waitMs === "number" ? p.waitMs : 2e3;
          const dec = new TextDecoder();
          let out = "";
          let err = "";
          let handle;
          try {
            handle = await proc.spawn(p.cmd, args, { cwd: p.cwd });
          } catch (e) {
            return { ok: false, error: `spawn \uC2E4\uD328: ${String(e)}` };
          }
          proc.onData(handle, (b) => {
            out += dec.decode(b, { stream: true });
          });
          proc.onStderr(handle, (b) => {
            err += dec.decode(b, { stream: true });
          });
          if (typeof p.stdin === "string") await proc.write(handle, p.stdin);
          const exitCode = await new Promise((resolve) => {
            let settled = false;
            const done = (code) => {
              if (settled) return;
              settled = true;
              resolve(code);
            };
            proc.onExit(handle, (code) => done(code));
            setTimeout(() => {
              proc.kill(handle);
              done(null);
            }, waitMs);
          });
          return { ok: true, stdout: out, stderr: err, exitCode };
        }
      })
    );
  },
  deactivate() {
  }
};
export {
  main_default as default
};
