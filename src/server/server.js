import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApiRequest } from "./router.js";
import { createPlatformService } from "./services.js";
import { PlatformStore } from "./store.js";
import {
  secureResponse,
  validateRequest,
  readJsonBody,
  writeVersion,
} from "./http-boundary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "../ui");

const staticFiles = new Map([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  [
    "/app.js",
    { file: "app.js", contentType: "application/javascript; charset=utf-8" },
  ],
  [
    "/styles.css",
    { file: "styles.css", contentType: "text/css; charset=utf-8" },
  ],
]);

export function createAppServer({ store = new PlatformStore() } = {}) {
  store.init();
  const service = createPlatformService(store);

  const server = http.createServer(async (request, response) => {
    const requestId = secureResponse(response);
    try {
      const url = validateRequest(request);
      if (url.pathname.startsWith("/api/")) {
        // Read the bounded body before capturing authorization and workspace state.
        if (["POST", "PATCH", "DELETE"].includes(request.method))
          await readJsonBody(request);
        const expectedVersion = writeVersion(request, url);
        const handled = await store.runRequest(expectedVersion, () => {
          response.workspaceRevision = () => store.getState().meta.version;
          return handleApiRequest(request, response, { store, service });
        });
        if (handled === false) {
          response.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ error: "Route not found" }));
        }
        return;
      }

      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, {
          Allow: "GET, HEAD",
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify({ error: "Method not supported", requestId }),
        );
        return;
      }
      const route = staticFiles.get(url.pathname);
      if (!route) {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Not found");
        return;
      }

      const filePath = path.join(uiDir, route.file);
      const contents = fs.readFileSync(filePath);
      response.writeHead(200, { "Content-Type": route.contentType });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error.closeConnection) response.setHeader("Connection", "close");
      response.writeHead(error.status || 500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: error.status
            ? error.message
            : "The operation could not be completed",
          requestId,
        }),
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be 1..65535");
  const server = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Feature flag platform listening on http://127.0.0.1:${port}`);
  });
}
