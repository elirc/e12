import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApiRequest } from "./router.js";
import { createPlatformService } from "./services.js";
import { PlatformStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "../ui");

const staticFiles = new Map([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", contentType: "application/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
]);

export function createAppServer() {
  const store = new PlatformStore();
  store.init();
  const service = createPlatformService(store);

  return http.createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    if (request.url.startsWith("/api/")) {
      const handled = await handleApiRequest(request, response, { store, service });
      if (handled === false) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Route not found" }));
      }
      return;
    }

    const route = staticFiles.get(new URL(request.url, "http://localhost").pathname);
    if (!route) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const filePath = path.join(uiDir, route.file);
    const contents = fs.readFileSync(filePath);
    response.writeHead(200, { "Content-Type": route.contentType });
    response.end(contents);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`Feature flag platform listening on http://localhost:${port}`);
  });
}
