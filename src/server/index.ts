import { loadConfig } from "../config";

const config = loadConfig();

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  routes: {
    "/health": new Response("ok"),
    "/ready": new Response("ok"),
    "/webhook": {
      POST: async (req) => {
        // Phase 2 will wire signature verification and event routing here.
        return new Response("not implemented", { status: 501 });
      },
    },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    msg: "server started",
    hostname: server.hostname,
    port: server.port,
  }),
);
