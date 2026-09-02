import { defineConfig, type Plugin } from "vite";
import { dataStatus, refreshData } from "./server/refresh.mjs";

/** 开发服务器中间件: /api/refresh + /api/status */
function refreshPlugin(): Plugin {
  return {
    name: "fgo-data-refresh",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = req.url ?? "";
          if (url.startsWith("/api/refresh") && req.method === "POST") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(await refreshData(process.cwd())));
            return;
          }
          if (url.startsWith("/api/status")) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(await dataStatus(process.cwd())));
            return;
          }
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: String(e) }));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  plugins: [refreshPlugin()],
});
