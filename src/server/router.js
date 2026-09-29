import { readJsonBody, httpError } from "./http-boundary.js";

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (!["true", "false"].includes(value))
    throw httpError(422, "Boolean query values must be true or false");
  return value === "true";
}

export function sendJson(response, statusCode, payload, headers = {}) {
  if (response.workspaceRevision)
    response.setHeader("ETag", `"${response.workspaceRevision()}"`);
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
    const resourceMethods = {
      projects: "Project",
      environments: "Environment",
      flags: "Flag",
      strategies: "Strategy",
      segments: "Segment",
      variants: "Variant",
      dependencies: "Dependency",
    };
    const deletion = /^\/api\/admin\/([a-z]+)\/([A-Za-z0-9_-]+)$/.exec(
      url.pathname,
    );
    if (
      request.method === "DELETE" &&
      deletion &&
      Object.hasOwn(resourceMethods, deletion[1])
    ) {
      const actor = service.getActorFromHeaders(
        request.headers,
        ["projects", "environments"].includes(deletion[1]) ? "admin" : "write",
      );
      return sendJson(
        response,
        200,
        service[`delete${resourceMethods[deletion[1]]}`](
          actor,
          deletion[2],
          await readJsonBody(request),
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/admin/bootstrap") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, {
        revision: store.getState().meta.version,
        actor: {
          id: actor.user.id,
          name: actor.user.name,
          roles: actor.user.roles,
          scopes: actor.token.scopes,
        },
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
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(
        response,
        201,
        service.createProject(actor, await readJsonBody(request)),
      );
    }

    const projectMatch = matchPath(
      url.pathname,
      "/api/admin/projects/:projectId",
    );
    if (request.method === "PATCH" && projectMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateProject(
          actor,
          projectMatch.projectId,
          await readJsonBody(request),
        ),
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/environments"
    ) {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listEnvironments(actor));
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/environments"
    ) {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(
        response,
        201,
        service.createEnvironment(actor, await readJsonBody(request)),
      );
    }
    const environmentMatch = matchPath(
      url.pathname,
      "/api/admin/environments/:environmentId",
    );
    if (request.method === "PATCH" && environmentMatch) {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(
        response,
        200,
        service.updateEnvironment(
          actor,
          environmentMatch.environmentId,
          await readJsonBody(request),
        ),
      );
    }

    if (request.method === "GET" && url.pathname === "/api/admin/flags") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(
        response,
        200,
        service.listFlags(actor, {
          projectId: url.searchParams.get("projectId") || undefined,
          type: url.searchParams.get("type") || undefined,
          stale: parseBoolean(url.searchParams.get("stale")),
          archived: parseBoolean(url.searchParams.get("archived")),
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/flags") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        201,
        service.createFlag(actor, await readJsonBody(request)),
      );
    }

    const flagMatch = matchPath(url.pathname, "/api/admin/flags/:flagId");
    if (request.method === "PATCH" && flagMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateFlag(
          actor,
          flagMatch.flagId,
          await readJsonBody(request),
        ),
      );
    }

    const staleMatch = matchPath(
      url.pathname,
      "/api/admin/flags/:flagId/stale",
    );
    if (request.method === "POST" && staleMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.changeFlagLifecycle(
          actor,
          staleMatch.flagId,
          "stale",
          await readJsonBody(request),
        ),
      );
    }

    const archiveMatch = matchPath(
      url.pathname,
      "/api/admin/flags/:flagId/archive",
    );
    if (request.method === "POST" && archiveMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.changeFlagLifecycle(
          actor,
          archiveMatch.flagId,
          "archive",
          await readJsonBody(request),
        ),
      );
    }

    const unarchiveMatch = matchPath(
      url.pathname,
      "/api/admin/flags/:flagId/unarchive",
    );
    if (request.method === "POST" && unarchiveMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.changeFlagLifecycle(
          actor,
          unarchiveMatch.flagId,
          "unarchive",
          await readJsonBody(request),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/segments") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        201,
        service.createSegment(actor, await readJsonBody(request)),
      );
    }

    const segmentMatch = matchPath(
      url.pathname,
      "/api/admin/segments/:segmentId",
    );
    if (request.method === "PATCH" && segmentMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateSegment(
          actor,
          segmentMatch.segmentId,
          await readJsonBody(request),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/strategies") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        201,
        service.createStrategy(actor, await readJsonBody(request)),
      );
    }

    const strategyMatch = matchPath(
      url.pathname,
      "/api/admin/strategies/:strategyId",
    );
    if (request.method === "PATCH" && strategyMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateStrategy(
          actor,
          strategyMatch.strategyId,
          await readJsonBody(request),
        ),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/admin/variants") {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        201,
        service.createVariant(actor, await readJsonBody(request)),
      );
    }

    const variantMatch = matchPath(
      url.pathname,
      "/api/admin/variants/:variantId",
    );
    if (request.method === "PATCH" && variantMatch) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        200,
        service.updateVariant(
          actor,
          variantMatch.variantId,
          await readJsonBody(request),
        ),
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/dependencies"
    ) {
      const actor = service.getActorFromHeaders(request.headers, "write");
      return sendJson(
        response,
        201,
        service.createDependency(actor, await readJsonBody(request)),
      );
    }

    if (request.method === "GET" && url.pathname === "/api/admin/tokens") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listTokens(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/tokens") {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(
        response,
        201,
        service.createToken(actor, await readJsonBody(request)),
      );
    }

    const tokenMatch = matchPath(
      url.pathname,
      "/api/admin/tokens/:tokenId/revoke",
    );
    if (request.method === "POST" && tokenMatch) {
      const actor = service.getActorFromHeaders(request.headers, "admin");
      return sendJson(
        response,
        200,
        service.revokeToken(actor, tokenMatch.tokenId),
      );
    }

    if (request.method === "GET" && url.pathname === "/api/admin/audit") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(response, 200, service.listAudit(actor));
    }

    if (request.method === "POST" && url.pathname === "/api/admin/playground") {
      const actor = service.getActorFromHeaders(request.headers, "read");
      return sendJson(
        response,
        200,
        service.playground(actor, await readJsonBody(request)),
      );
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
      return sendJson(response, 200, result, { "Cache-Control": "no-store" });
    }

    if (request.method === "POST" && url.pathname === "/api/client/features") {
      const body = await readJsonBody(request);
      const result = service.evaluateClient(request.headers, body);
      return sendJson(response, 200, result, { "Cache-Control": "no-store" });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/metrics/impressions"
    ) {
      return sendJson(
        response,
        202,
        service.ingestMetrics(request.headers, await readJsonBody(request)),
      );
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
    if (error.closeConnection) response.setHeader("Connection", "close");
    sendJson(response, error.status || 500, {
      error: error.status
        ? error.message
        : "The operation could not be completed",
      requestId: response.getHeader("X-Request-Id"),
    });
    return true;
  }
}
