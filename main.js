// src/main.ts
var main_default = {
  activate(ctx) {
    const app = ctx.app;
    if (app.commands?.register) {
      ctx.subscriptions.push(
        app.commands.register("ping", {
          description: "ACP \uCF54\uC5B4 \uC801\uC7AC/\uBC84\uC804 \uD655\uC778(E2E)",
          handler: async () => ({
            ok: true,
            plugin: "soksak-plugin-acp-core",
            version: "0.0.1",
            phase: "M0"
          })
        })
      );
    }
  },
  deactivate() {
  }
};
export {
  main_default as default
};
