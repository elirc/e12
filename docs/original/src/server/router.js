function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return value === "true";
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload, null, 2));
}

function matchPath(pathname, pattern) {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedPart = expected[index];
    const actualPart = actual[index];
    if (expectedPart.startsWith(":")) {
      params[expectedPart.slice(1)] = actualPart;
      continue;
    }
    if (expectedPart !== actualPart) {
      return null;
    }
  }
  return params;
}

export async function handleApiRequest(request, response, { store, service }) {
  const url = new URL(request.url, "http://localhost");

  try {
    if (request.method === "GET" && url.pathname === "/api/admin/bootstrap") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, {
        users: service.listUsers(actor),
        projects: service.listProjects(actor),
        environments: service.listEnvironments(actor),
        flags: service.listFlags(actor, {}),
        segments: service.listSegments(actor),
        tokens: service.listTokens(actor),
        audit: service.listAudit(actor),
        resourceLimits: store.getState().resourceLimits,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/admin/projects") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listProjects(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/projects") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createProject(actor, await readJsonBody(request)));
    }

    const projectMatch = matchPath(url.pathname, "/api/admin/projects/:projectId");
    if (request.method === "PATCH" && projectMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateProject(actor, projectMatch.projectId, await readJsonBody(request)),
      );
    }

    if (request.method === "GET" && url.pathname === "/api/admin/environments") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listEnvironments(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/environments") {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(response, 201, service.createEnvironment(actor, await readJsonBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/flags") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listFlags(actor, {
        projectId: url.searchParams.get("projectId") || undefined,
        type: url.searchParams.get("type") || undefined,
        stale: parseBoolean(url.searchParams.get("stale")),
        archived: parseBoolean(url.searchParams.get("archived")),
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/flags") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createFlag(actor, await readJsonBody(request)));
    }

    const flagMatch = matchPath(url.pathname, "/api/admin/flags/:flagId");
    if (request.method === "PATCH" && flagMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateFlag(actor, flagMatch.flagId, await readJsonBody(request)),
      );
    }

    const staleMatch = matchPath(url.pathname, "/api/admin/flags/:flagId/stale");
    if (request.method === "POST" && staleMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 200, service.changeFlagLifecycle(actor, staleMatch.flagId, "stale"));
    }

    const archiveMatch = matchPath(url.pathname, "/api/admin/flags/:flagId/archive");
    if (request.method === "POST" && archiveMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 200, service.changeFlagLifecycle(actor, archiveMatch.flagId, "archive"));
    }

    const unarchiveMatch = matchPath(url.pathname, "/api/admin/flags/:flagId/unarchive");
    if (request.method === "POST" && unarchiveMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.changeFlagLifecycle(actor, unarchiveMatch.flagId, "unarchive"),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/segments") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createSegment(actor, await readJsonBody(request)));
    }

    const segmentMatch = matchPath(url.pathname, "/api/admin/segments/:segmentId");
    if (request.method === "PATCH" && segmentMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateSegment(actor, segmentMatch.segmentId, await readJsonBody(request)),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/strategies") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createStrategy(actor, await readJsonBody(request)));
    }

    const strategyMatch = matchPath(url.pathname, "/api/admin/strategies/:strategyId");
    if (request.method === "PATCH" && strategyMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateStrategy(actor, strategyMatch.strategyId, await readJsonBody(request)),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/variants") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createVariant(actor, await readJsonBody(request)));
    }

    const variantMatch = matchPath(url.pathname, "/api/admin/variants/:variantId");
    if (request.method === "PATCH" && variantMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateVariant(actor, variantMatch.variantId, await readJsonBody(request)),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/dependencies") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(response, 201, service.createDependency(actor, await readJsonBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/tokens") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listTokens(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/tokens") {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(response, 201, service.createToken(actor, await readJsonBody(request)));
    }

    const tokenMatch = matchPath(url.pathname, "/api/admin/tokens/:tokenId/revoke");
    if (request.method === "POST" && tokenMatch) {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(response, 200, service.revokeToken(actor, tokenMatch.tokenId));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/audit") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listAudit(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/playground") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.playground(actor, await readJsonBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/admin/dashboard") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(
        response,
        200,
        service.getDashboard(
          actor,
          url.searchParams.get("projectId"),
          url.searchParams.get("environmentId"),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/client/evaluate") {
      const body = await readJsonBody(request);
      const result = service.evaluateClient(request.headers, body);
      if (result.notModified) {
        response.writeHead(304, { ETag: result.etag });
        response.end();
        return;
      }
      return sendJson(response, 200, result, { ETag: result.etag });
    }

    if (request.method === "POST" && url.pathname === "/api/client/features") {
      const body = await readJsonBody(request);
      const result = service.evaluateClient(request.headers, body);
      if (result.notModified) {
        response.writeHead(304, { ETag: result.etag });
        response.end();
        return;
      }
      return sendJson(response, 200, result, { ETag: result.etag });
    }

    if (request.method === "POST" && url.pathname === "/api/metrics/impressions") {
      return sendJson(response, 202, service.ingestMetrics(request.headers, await readJsonBody(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/metrics/summary") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(
        response,
        200,
        service.summarizeMetrics(actor, {
          projectId: url.searchParams.get("projectId"),
          environmentId: url.searchParams.get("environmentId"),
        }),
      );
    }

    return false;
  } catch (error) {
    sendJson(response, error.status || 500, {
      error: error.message || "Internal server error",
      details: error.details || {},
    });
    return true;
  }
}
