const $ = (selector) => document.querySelector(selector);
const state = {
  token: "",
  data: null,
  kind: "flags",
  scope: "",
  page: 1,
  selected: null,
  busy: false,
  generation: 0,
  editor: null,
  review: null,
};
const kinds = {
  projects: "project",
  environments: "environment",
  flags: "flag",
  strategies: "strategy",
  segments: "segment",
  variants: "variant",
  dependencies: "dependency",
  tokens: "token",
};
const widgets = new Map();
const form = $("#editor-form");
const stable = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) => a.localeCompare(b)),
        )
      : child,
  );
const same = (a, b) => stable(a) === stable(b);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function flash(message, error = false) {
  $("#flash").textContent = message;
  $("#flash").classList.toggle("error", error);
}
function busy(value) {
  state.busy = value;
  syncControls();
}
function isAdmin() {
  return (
    state.data?.actor.roles.includes("instance_admin") &&
    state.data.actor.scopes.includes("admin")
  );
}
function projectById(id) {
  return state.data?.projects.find((item) => item.id === id);
}
function flagById(id) {
  return state.data?.flags.find((item) => item.id === id);
}
function strategies() {
  return (state.data?.flags ?? []).flatMap((flag) =>
    flag.strategies.map((strategy) => ({
      ...strategy,
      projectId: flag.projectId,
    })),
  );
}
function variants() {
  return strategies().flatMap((strategy) =>
    strategy.variants.map((variant) => ({
      ...variant,
      flagId: strategy.flagId,
      projectId: strategy.projectId,
      environmentId: strategy.environmentId,
    })),
  );
}
function records(kind = state.kind) {
  if (!state.data) return [];
  if (kind === "strategies") return strategies();
  if (kind === "variants") return variants();
  if (kind === "dependencies")
    return [
      ...new Map(
        state.data.flags
          .flatMap((flag) => flag.dependencies)
          .map((item) => [item.id, item]),
      ).values(),
    ];
  return state.data[kind] ?? [];
}
function displayName(record, kind = state.kind) {
  return kind === "dependencies"
    ? `${flagById(record.parentFlagId)?.key ?? record.parentFlagId} → ${flagById(record.childFlagId)?.key ?? record.childFlagId}`
    : (record.name ?? record.key ?? record.id);
}
function recordProject(record, kind = state.kind) {
  return kind === "projects" ? record?.id : (record?.projectId ?? null);
}
function canWrite(record = state.editor?.record) {
  if (!state.data) return false;
  if (
    ["environments", "tokens"].includes(state.kind) ||
    (state.kind === "projects" && !record)
  )
    return isAdmin();
  if (
    state.kind === "segments" &&
    (record
      ? record.projectId === null
      : widgets.get("projectId")?.read() === null)
  )
    return isAdmin();
  if (!state.data.actor.scopes.includes("write")) return false;
  if (state.data.actor.roles.includes("instance_admin")) return true;
  const projectId =
    recordProject(record) ??
    rawReference("projectId") ??
    flagById(
      rawReference("flagId") ??
        rawReference("childFlagId") ??
        record?.childFlagId,
    )?.projectId ??
    strategies().find((item) => item.id === rawReference("strategyId"))
      ?.projectId ??
    state.scope;
  const project = projectById(projectId);
  return (
    state.data.actor.roles.some((role) =>
      ["project_owner", "project_member"].includes(role),
    ) && ["project_owner", "project_member"].includes(project?.membershipRole)
  );
}
function rawReference(name) {
  try {
    return widgets.get(name)?.read();
  } catch {
    return null;
  }
}
function hasDraft() {
  return Boolean(
    state.editor &&
      [...widgets].some(
        ([name, widget]) => !same(widget.raw(), state.editor.baseRaw[name]),
      ),
  );
}
function mayLeave() {
  return (
    !state.busy &&
    (!hasDraft() || confirm("Discard this unsaved draft and change records?"))
  );
}
function apiError(error) {
  flash(error.message, true);
}
async function api(
  path,
  { method = "GET", body, revision, token = state.token } = {},
) {
  const write = method !== "GET" && path !== "/api/admin/playground";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(write ? { "If-Match": `"${revision}"` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw Object.assign(
        new Error(
          write
            ? "The response was lost or timed out. The server may have accepted this change. Review the latest state before trying again."
            : "The workspace could not be reached. Try refreshing after the connection returns.",
        ),
        { uncertain: write },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Object.assign(
        new Error(
          write
            ? "The response could not be read. Review the latest state before retrying this change."
            : "The server returned an unreadable response.",
        ),
        { uncertain: write },
      );
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          write && response.status >= 500
            ? "The server reported an error. The change may have been accepted; review the latest state before retrying."
            : payload.error || `Request failed (${response.status}).`,
        ),
        { status: response.status, uncertain: write && response.status >= 500 },
      );
    return {
      payload,
      revision: Number(response.headers.get("etag")?.replaceAll('"', "")),
    };
  } finally {
    clearTimeout(timer);
  }
}
function optionsFor(items, label = (item) => item.name ?? item.key) {
  return items.map((item) => ({ value: item.id, label: label(item) }));
}
function fillSelect(
  select,
  options,
  value,
  { multiple = false, blank = false } = {},
) {
  select.replaceChildren();
  select.multiple = multiple;
  if (blank) {
    const option = node("option", typeof blank === "string" ? blank : "None");
    option.value = "";
    select.append(option);
  }
  const values = multiple ? (value ?? []) : [value ?? ""];
  for (const item of options) {
    const option = node("option", item.label);
    option.value = item.value;
    option.selected = values.includes(item.value);
    select.append(option);
  }
  for (const previous of values.filter(
    (value) => value && !options.some((item) => item.value === value),
  )) {
    const option = node("option", `Unavailable reference (${previous})`);
    option.value = previous;
    option.selected = true;
    select.append(option);
  }
  if (!multiple) select.value = value ?? "";
}
function defaultProject() {
  return projectById(state.scope) ?? state.data.projects[0];
}
function developmentFor(project) {
  return (
    project?.environments.find((item) => item.key === "development") ??
    project?.environments[0]
  );
}
function definitions(record) {
  const create = !record,
    project = defaultProject();
  const projects = optionsFor(state.data.projects),
    environments = optionsFor(
      state.data.environments,
      (item) => `${item.name}${item.protectChanges ? " (protected)" : ""}`,
    );
  const flags = optionsFor(
    state.data.flags,
    (item) =>
      `${projectById(item.projectId)?.key ?? "Project"} / ${item.key}${item.archived ? " (archived)" : ""}`,
  );
  const strategiesList = optionsFor(
    strategies(),
    (item) => `${flagById(item.flagId)?.key ?? "Flag"} / ${item.name}`,
  );
  const f = (name, label, type = "text", extra = {}) => ({
    name,
    label,
    type,
    ...extra,
  });
  const name = f("name", "Name", "text", { required: true, max: 100 });
  const key = f("key", "Key", "text", {
    required: true,
    max: 80,
    help: "Lowercase letters, numbers, underscores and hyphens. SDK callers use flag keys.",
  });
  const description = f("description", "Description", "textarea", {
    wide: true,
    max: 5000,
  });
  const json = (name, label, fallback, help) =>
    f(name, label, "json", { wide: true, fallback, help });
  if (state.kind === "projects")
    return [
      name,
      ...(create ? [key] : []),
      description,
      f("ownerUserId", "Owner", "select", {
        choices: optionsFor(
          state.data.users.filter((item) => item.active !== false),
        ),
        fallback: state.data.actor.id,
        required: true,
      }),
      f("environmentIds", "Enabled environments", "multi", {
        choices: environments,
        fallback: developmentFor(project) ? [developmentFor(project).id] : [],
        required: true,
        help: "Select one or more. Referenced environments cannot be detached.",
      }),
      json(
        "defaultStrategies",
        "Environment defaults (JSON)",
        {},
        "Maps environment IDs to default strategy definitions. An omitted new default is disabled.",
      ),
    ];
  if (state.kind === "environments")
    return [
      name,
      ...(create ? [key] : []),
      f("type", "Environment type", "select", {
        values: ["development", "test", "pre-production", "production"],
        fallback: "test",
        required: true,
      }),
      f("protectChanges", "Require acknowledgment for changes", "checkbox"),
    ];
  if (state.kind === "flags")
    return [
      name,
      key,
      ...(create
        ? [
            f("projectId", "Project", "select", {
              choices: projects,
              fallback: project?.id,
              required: true,
            }),
            f("environmentIds", "Target environments", "multi", {
              choices: optionsFor(project?.environments ?? []),
              fallback: developmentFor(project)
                ? [developmentFor(project).id]
                : [],
              required: true,
            }),
          ]
        : []),
      f("type", "Flag type", "select", {
        values: [
          "release",
          "experiment",
          "operational",
          "kill_switch",
          "permission",
        ],
        fallback: "release",
        required: true,
      }),
      description,
      f("impressionData", "Enable impression data", "checkbox"),
      ...(create
        ? []
        : [
            f("stale", "Mark as stale", "checkbox"),
            f("archived", "Archive this flag", "checkbox"),
          ]),
    ];
  if (state.kind === "segments")
    return [
      name,
      ...(create
        ? [
            f("projectId", "Project", "nullableSelect", {
              choices: projects,
              blank: "Shared across projects (administrator only)",
              fallback: project?.id ?? null,
            }),
          ]
        : []),
      description,
      json(
        "constraints",
        "Constraints (JSON)",
        [],
        'Example: [{"field":"plan","operator":"in","values":["pro"]}]',
      ),
    ];
  if (state.kind === "strategies")
    return [
      name,
      ...(create
        ? [
            f("flagId", "Flag", "select", {
              choices: flags,
              fallback: state.data.flags.find(
                (item) => !state.scope || item.projectId === state.scope,
              )?.id,
              required: true,
            }),
            f("environmentId", "Environment", "select", {
              choices: environments,
              fallback: developmentFor(project)?.id,
              required: true,
            }),
          ]
        : []),
      f("type", "Strategy type", "select", {
        values: ["disabled", "enabled_for_all", "gradual_rollout"],
        fallback: "disabled",
        required: true,
      }),
      json(
        "parameters",
        "Parameters (JSON)",
        {},
        'Gradual rollout example: {"rollout":25,"stickiness":"userId"}. Other strategy types use {}.',
      ),
      json(
        "constraints",
        "Constraints (JSON)",
        [],
        "All constraints must match before this strategy can enable a flag.",
      ),
      f("segmentIds", "Reusable segments", "multi", {
        choices: optionsFor(state.data.segments),
        fallback: [],
      }),
      f("sortOrder", "Evaluation order", "number", {
        fallback: 1,
        max: 10000,
        required: true,
      }),
      json(
        "variants",
        "Variants (JSON)",
        [],
        'Replace variants together when rebalancing. Example: [{"name":"control","weight":50},{"name":"treatment","weight":50}]',
      ),
    ];
  if (state.kind === "variants")
    return [
      name,
      ...(create
        ? [
            f("strategyId", "Strategy", "select", {
              choices: strategiesList,
              fallback: strategies()[0]?.id,
              required: true,
            }),
          ]
        : []),
      f("weight", "Weight (%)", "number", {
        fallback: 0,
        max: 100,
        required: true,
      }),
      f("stickiness", "Stickiness field", "text", {
        fallback: "userId",
        required: true,
        max: 128,
      }),
      f("payloadType", "Payload type", "select", {
        values: ["string", "json"],
        fallback: "string",
        required: true,
      }),
      f("payload", "Payload", "payload", {
        wide: true,
        fallback: "",
        help: "Text for string payloads; valid JSON for JSON payloads. Rebalance several weights in the strategy editor.",
      }),
    ];
  if (state.kind === "dependencies")
    return create
      ? [
          f("parentFlagId", "Required parent flag", "select", {
            choices: flags,
            fallback: state.data.flags[0]?.id,
            required: true,
          }),
          f("childFlagId", "Dependent child flag", "select", {
            choices: flags,
            fallback: state.data.flags[1]?.id,
            required: true,
          }),
        ]
      : [];
  if (state.kind === "tokens")
    return create
      ? [
          name,
          f("type", "Token type", "select", {
            values: ["client", "frontend", "personal"],
            fallback: "client",
            required: true,
          }),
          f("scopes", "Allowed operations", "multi", {
            values: ["read", "write", "admin", "evaluate"],
            fallback: ["evaluate"],
            required: true,
          }),
          f("userId", "Token user", "select", {
            choices: optionsFor(
              state.data.users.filter((item) => item.active !== false),
            ),
            fallback: state.data.actor.id,
            required: true,
          }),
          f("projectIds", "Evaluation project", "oneArray", {
            choices: projects,
            fallback: project ? [project.id] : [],
            required: true,
          }),
          f("environmentIds", "Evaluation environment", "oneArray", {
            choices: optionsFor(project?.environments ?? []),
            fallback: developmentFor(project)
              ? [developmentFor(project).id]
              : [],
            required: true,
          }),
          f("expiresAt", "Expires at (optional, local time)", "datetime", {
            fallback: null,
          }),
        ]
      : [];
  return [];
}
function valuesFor(record) {
  if (!record) return {};
  if (state.kind === "projects")
    return {
      ...record,
      environmentIds: record.environments.map((item) => item.id),
      defaultStrategies: Object.fromEntries(
        record.environments.map((item) => [item.id, item.defaultStrategy]),
      ),
    };
  if (state.kind === "strategies")
    return {
      ...record,
      variants: record.variants.map((item) =>
        Object.fromEntries(
          ["name", "weight", "stickiness", "payloadType", "payload"]
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]),
        ),
      ),
    };
  return record;
}
function addField(def, value) {
  const row = node("label", undefined, `field${def.wide ? " wide" : ""}`);
  row.htmlFor = `field-${def.name}`;
  row.append(node("span", def.label));
  const selectType = ["select", "nullableSelect", "multi", "oneArray"].includes(
    def.type,
  );
  const input = document.createElement(
    selectType
      ? "select"
      : ["textarea", "json", "payload"].includes(def.type)
        ? "textarea"
        : "input",
  );
  input.id = `field-${def.name}`;
  input.name = def.name;
  input.setAttribute("aria-label", def.label);
  input.required = Boolean(def.required);
  input.spellcheck = !["json", "payload"].includes(def.type);
  if (input.tagName === "INPUT")
    input.type =
      def.type === "checkbox"
        ? "checkbox"
        : def.type === "number"
          ? "number"
          : def.type === "datetime"
            ? "datetime-local"
            : "text";
  if (def.type === "number") {
    input.min = "0";
    input.max = String(def.max);
    input.step = "1";
  } else if (!selectType && def.type !== "checkbox")
    input.maxLength = def.max ?? 20000;
  if (input.tagName === "TEXTAREA")
    input.rows = def.type === "textarea" ? 3 : 5;
  const choiceList = () =>
    def.choices ?? (def.values ?? []).map((value) => ({ value, label: value }));
  const set = (next) => {
    if (selectType)
      fillSelect(
        input,
        choiceList(),
        def.type === "oneArray" ? (next?.[0] ?? "") : next,
        { multiple: def.type === "multi", blank: def.blank ?? !def.required },
      );
    else if (def.type === "checkbox") input.checked = Boolean(next);
    else if (def.type === "json")
      input.value = JSON.stringify(next ?? def.fallback ?? {}, null, 2);
    else if (def.type === "payload")
      input.value =
        (widgets.get("payloadType")?.read() ??
          state.editor?.record?.payloadType ??
          "string") === "json"
          ? JSON.stringify(next ?? null, null, 2)
          : String(next ?? "");
    else if (def.type === "datetime")
      input.value = next
        ? new Date(
            new Date(next).getTime() -
              new Date(next).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "";
    else input.value = next ?? "";
  };
  const raw = () =>
    def.type === "checkbox"
      ? input.checked
      : def.type === "multi"
        ? [...input.selectedOptions].map((item) => item.value)
        : input.value;
  const read = () => {
    if (
      def.type === "json" ||
      (def.type === "payload" && widgets.get("payloadType")?.read() === "json")
    ) {
      try {
        return JSON.parse(input.value);
      } catch {
        throw new Error(`${def.label} must contain valid JSON.`);
      }
    }
    if (def.type === "checkbox" || def.type === "multi") return raw();
    if (def.type === "oneArray") return input.value ? [input.value] : [];
    if (def.type === "nullableSelect") return input.value || null;
    if (def.type === "number") {
      if (!input.value.trim()) throw new Error(`${def.label} is required.`);
      return Number(input.value);
    }
    if (def.type === "datetime")
      return input.value ? new Date(input.value).toISOString() : null;
    return input.value;
  };
  widgets.set(def.name, {
    input,
    row,
    def,
    set,
    read,
    raw,
    replaceChoices: (choices, value) => {
      def.choices = choices;
      set(value);
    },
  });
  set(value ?? def.fallback);
  row.append(input);
  if (def.help) row.append(node("small", def.help));
  $("#fields").append(row);
}
function readForm() {
  const values = Object.fromEntries(
    [...widgets].map(([name, widget]) => [name, widget.read()]),
  );
  if (state.kind === "tokens") {
    const personal = values.type === "personal";
    values.userId = personal ? values.userId : null;
    values.projectIds = personal ? [] : values.projectIds;
    values.environmentIds = personal ? [] : values.environmentIds;
  }
  return values;
}
function changes() {
  const values = readForm();
  return state.editor?.record
    ? Object.fromEntries(
        Object.entries(values).filter(
          ([key, value]) => !same(value, state.editor.baseValues[key]),
        ),
      )
    : values;
}
function configureReferences(changed, initial = false) {
  const current = (name) => rawReference(name);
  const replace = (name, choices, value) =>
    widgets.get(name)?.replaceChoices(choices, value);
  if (
    state.kind === "flags" &&
    !state.editor.record &&
    (changed === "projectId" || initial)
  ) {
    const project = projectById(current("projectId"));
    replace(
      "environmentIds",
      optionsFor(project?.environments ?? []),
      initial
        ? current("environmentIds")
        : developmentFor(project)
          ? [developmentFor(project).id]
          : [],
    );
  }
  if (state.kind === "strategies" && (changed === "flagId" || initial)) {
    const flag = state.editor.record
      ? flagById(state.editor.record.flagId)
      : flagById(current("flagId"));
    if (widgets.has("environmentId"))
      replace(
        "environmentId",
        optionsFor(flag?.environments ?? []),
        initial ? current("environmentId") : flag?.environments[0]?.id,
      );
    replace(
      "segmentIds",
      optionsFor(
        state.data.segments.filter(
          (item) =>
            item.projectId === null || item.projectId === flag?.projectId,
        ),
      ),
      initial ? current("segmentIds") : [],
    );
  }
  if (
    state.kind === "variants" &&
    !state.editor.record &&
    (changed === "strategyId" || initial)
  ) {
    const strategy = strategies().find(
      (item) => item.id === current("strategyId"),
    );
    widgets.get("weight").set(strategy?.variants.length ? 0 : 100);
    widgets
      .get("stickiness")
      .set(
        strategy?.variants[0]?.stickiness ??
          strategy?.parameters?.stickiness ??
          "userId",
      );
  }
  if (state.kind === "tokens" && !state.editor.record) {
    const personal = current("type") === "personal";
    widgets.get("userId").row.hidden = !personal;
    widgets.get("projectIds").row.hidden = personal;
    widgets.get("environmentIds").row.hidden = personal;
    widgets.get("userId").input.required = personal;
    widgets.get("projectIds").input.required = !personal;
    widgets.get("environmentIds").input.required = !personal;
    if (changed === "type")
      widgets.get("scopes").set(personal ? ["read"] : ["evaluate"]);
    if (changed === "projectIds" || initial) {
      const project = projectById(current("projectIds")?.[0]);
      replace(
        "environmentIds",
        optionsFor(project?.environments ?? []),
        initial
          ? current("environmentIds")
          : developmentFor(project)
            ? [developmentFor(project).id]
            : [],
      );
    }
  }
}
function renderEditor(record = null, retained = null) {
  state.selected = record?.id ?? null;
  state.review = null;
  $("#review-panel").hidden = true;
  state.editor = {
    record,
    revision: state.data.revision,
    baseValues: {},
    baseRaw: {},
    needsReview: false,
    needsReload: false,
  };
  widgets.clear();
  $("#fields").replaceChildren();
  $("#editor-title").textContent =
    `${record ? "Review" : "New"} ${kinds[state.kind]}${record ? `: ${displayName(record)}` : ""}`;
  $("#editor-context").textContent = record
    ? `Record ${record.id} · Workspace revision ${state.data.revision}`
    : `New record based on workspace revision ${state.data.revision}`;
  $("#editor-help").textContent =
    state.kind === "tokens"
      ? "Personal tokens follow a user's permissions. Client and frontend tokens evaluate one project and environment. Existing tokens can be revoked; their secret is never shown again."
      : state.kind === "dependencies"
        ? "A child flag requires its parent to be enabled. Pairs are immutable; remove and recreate a dependency to change it."
        : state.kind === "variants"
          ? "Weights in a strategy must total 100. Use the strategy's variants editor to rebalance multiple weights together."
          : "Changes are validated together. A stale workspace revision requires review before another save.";
  const values = valuesFor(record);
  for (const def of definitions(record)) addField(def, values[def.name]);
  if (record && ["tokens", "dependencies"].includes(state.kind)) {
    const details = node("dl", undefined, "record-meta");
    for (const [key, value] of Object.entries(record)) {
      if (key === "hash") continue;
      details.append(
        node("dt", key),
        node(
          "dd",
          typeof value === "object"
            ? JSON.stringify(value)
            : String(value ?? "None"),
        ),
      );
    }
    $("#fields").append(details);
  }
  configureReferences(null, true);
  state.editor.baseValues = readForm();
  state.editor.baseRaw = Object.fromEntries(
    [...widgets].map(([key, widget]) => [key, widget.raw()]),
  );
  if (retained)
    for (const [key, value] of Object.entries(retained))
      widgets.get(key)?.set(value);
  $("#delete-record").textContent =
    state.kind === "tokens" ? "Revoke token" : "Delete record";
  renderProtection();
  renderList();
  syncControls();
}
function protectedEnvironments() {
  const record = state.editor?.record;
  let ids = [];
  if (!state.editor) return [];
  if (state.kind === "projects") {
    let delta = {};
    try {
      delta = changes();
    } catch {}
    const previous = record?.environments.map((item) => item.id) ?? [];
    const selected = rawReference("environmentIds") ?? [];
    if (!record) ids = selected;
    else {
      if (delta.environmentIds)
        ids.push(
          ...new Set(
            [...previous, ...selected].filter(
              (id) => previous.includes(id) !== selected.includes(id),
            ),
          ),
        );
      if (delta.defaultStrategies)
        ids.push(...Object.keys(delta.defaultStrategies));
    }
  }
  if (state.kind === "environments" && record) ids = [record.id];
  if (state.kind === "flags")
    ids = record
      ? record.environments.map((item) => item.id)
      : (rawReference("environmentIds") ?? []);
  if (state.kind === "strategies")
    ids = [record?.environmentId ?? rawReference("environmentId")];
  if (state.kind === "variants")
    ids = [
      record?.environmentId ??
        strategies().find((item) => item.id === rawReference("strategyId"))
          ?.environmentId,
    ];
  if (state.kind === "segments" && record)
    ids = strategies()
      .filter((item) => item.segmentIds.includes(record.id))
      .map((item) => item.environmentId);
  if (state.kind === "dependencies")
    ids =
      flagById(
        record?.childFlagId ?? rawReference("childFlagId"),
      )?.environments.map((item) => item.id) ?? [];
  return state.data.environments.filter(
    (item) => ids.includes(item.id) && item.protectChanges,
  );
}
function renderProtection() {
  const environments = protectedEnvironments();
  const container = $("#protection");
  container.replaceChildren();
  container.hidden = !environments.length;
  if (environments.length) {
    const label = node("label", undefined, "check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "protected-ack";
    checkbox.addEventListener("change", syncControls);
    label.append(
      checkbox,
      node(
        "span",
        `I reviewed this change affecting protected environments: ${environments.map((item) => item.name).join(", ")}.`,
      ),
    );
    container.append(label);
  }
}
function confirmations() {
  const environments = protectedEnvironments();
  if (environments.length && !$("#protected-ack")?.checked)
    throw new Error(
      "Acknowledge the protected environments before saving this change.",
    );
  return environments.map((item) => `CONFIRM:${item.key}`);
}
function filtered() {
  const search = $("#search").value.trim().toLowerCase();
  return records()
    .filter(
      (record) =>
        !state.scope ||
        ["projects", "environments", "tokens"].includes(state.kind) ||
        record.projectId == null ||
        recordProject(record) === state.scope,
    )
    .filter((record) =>
      `${displayName(record)} ${record.key ?? ""}`
        .toLowerCase()
        .includes(search),
    )
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}
function renderList() {
  const list = filtered();
  const maxPage = Math.max(1, Math.ceil(list.length / 20));
  state.page = Math.min(state.page, maxPage);
  const container = $("#record-list");
  container.replaceChildren();
  for (const record of list.slice((state.page - 1) * 20, state.page * 20)) {
    const button = node(
      "button",
      undefined,
      `record${record.id === state.selected ? " active" : ""}`,
    );
    button.type = "button";
    button.dataset.recordId = record.id;
    button.append(node("strong", displayName(record)));
    const project = projectById(recordProject(record));
    const environment = state.data.environments.find(
      (item) => item.id === record.environmentId,
    );
    button.append(
      node(
        "small",
        [
          record.key,
          project?.name,
          environment?.name,
          record.archived ? "Archived" : null,
          record.revokedAt ? "Revoked" : null,
        ]
          .filter(Boolean)
          .join(" · ") || record.id,
      ),
    );
    button.addEventListener("click", () => {
      if (mayLeave()) renderEditor(record);
    });
    container.append(button);
  }
  if (!list.length)
    container.append(node("p", "No matching records.", "muted"));
  $("#page-label").textContent =
    `Page ${state.page} of ${maxPage} · ${list.length} records`;
  $("#previous").disabled = state.busy || state.page <= 1;
  $("#next").disabled = state.busy || state.page >= maxPage;
}
function syncControls() {
  for (const control of document.querySelectorAll(
    "#workspace input,#workspace select,#workspace textarea,#workspace button,#sign-out",
  ))
    control.disabled = state.busy;
  if (!state.data || !state.editor) return;
  const allowed = canWrite();
  const immutable =
    state.editor.record && ["tokens", "dependencies"].includes(state.kind);
  const acknowledged =
    !protectedEnvironments().length || $("#protected-ack")?.checked;
  $("#save-record").disabled =
    state.busy ||
    !allowed ||
    immutable ||
    state.editor.needsReview ||
    state.editor.needsReload ||
    !acknowledged;
  $("#delete-record").disabled =
    state.busy ||
    !state.editor.record ||
    !allowed ||
    state.editor.needsReview ||
    state.editor.needsReload ||
    (state.kind === "tokens" && Boolean(state.editor.record.revokedAt));
  $("#new-record").disabled =
    state.busy ||
    (["projects", "environments", "tokens"].includes(state.kind) && !isAdmin());
  $("#permission-note").textContent = allowed
    ? ""
    : "Your current token or project role does not allow this change. You can still inspect the record.";
  const count = filtered().length;
  $("#previous").disabled = state.busy || state.page <= 1;
  $("#next").disabled =
    state.busy || state.page >= Math.max(1, Math.ceil(count / 20));
  if (state.kind === "tokens" && !state.editor.record) {
    const personal = rawReference("type") === "personal";
    widgets.get("userId").input.disabled = state.busy || !personal;
    widgets.get("projectIds").input.disabled = state.busy || personal;
    widgets.get("environmentIds").input.disabled = state.busy || personal;
  }
}
function renderWorkspaceChrome() {
  $("#identity").textContent =
    `${state.data.actor.name} · ${state.data.actor.roles.join(", ")}`;
  $("#revision").textContent = `Workspace revision ${state.data.revision}`;
  if (state.scope && !projectById(state.scope)) state.scope = "";
  fillSelect(
    $("#project-scope"),
    optionsFor(state.data.projects),
    state.scope,
    { blank: "All readable projects" },
  );
  const selected = $("#playground-project").value;
  fillSelect(
    $("#playground-project"),
    optionsFor(state.data.projects),
    projectById(selected)?.id ?? defaultProject()?.id,
  );
  configurePlayground();
  $("#audit-list").replaceChildren();
  const audit = state.data.audit
    .filter((entry) => !state.scope || entry.projectId === state.scope)
    .slice(0, 20);
  for (const entry of audit) {
    const card = node("div", undefined, "audit-entry");
    card.append(
      node("strong", entry.action),
      node(
        "small",
        `${entry.resourceType} · ${entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "Earlier record"}`,
      ),
    );
    $("#audit-list").append(card);
  }
  if (!audit.length)
    $("#audit-list").append(
      node("p", "No accepted changes in this view yet.", "muted"),
    );
}
function configurePlayground() {
  const project = projectById($("#playground-project").value);
  const previous = $("#playground-environment").value;
  fillSelect(
    $("#playground-environment"),
    optionsFor(project?.environments ?? []),
    project?.environments.some((item) => item.id === previous)
      ? previous
      : developmentFor(project)?.id,
  );
}
async function loadData() {
  const generation = state.generation;
  const { payload } = await api("/api/admin/bootstrap");
  if (generation !== state.generation)
    throw new Error("The session changed before this response arrived.");
  state.data = payload;
  renderWorkspaceChrome();
  return payload;
}
async function reviewLatest() {
  if (state.busy) return;
  let draft;
  try {
    draft = changes();
  } catch (error) {
    apiError(error);
    return;
  }
  const recordId = state.selected;
  busy(true);
  try {
    await loadData();
    const latest = recordId
      ? records().find((item) => item.id === recordId)
      : null;
    state.review = {
      latest,
      draft,
      revision: state.data.revision,
      missing: Boolean(recordId && !latest),
    };
    $("#review-panel").hidden = false;
    $("#latest-record").textContent = JSON.stringify(
      latest ?? records().slice(0, 20),
      null,
      2,
    );
    $("#draft-record").textContent = JSON.stringify(draft, null, 2);
    $("#review-message").textContent = state.review.missing
      ? "This record was removed. Keep a copy of the draft, then start a new record if appropriate."
      : recordId
        ? "Only your changed fields will be kept. Unedited fields will use the latest accepted values."
        : "Check the current list for an already accepted creation before submitting this draft again.";
    $("#accept-review").hidden = state.review.missing;
    renderList();
    flash("Latest state loaded. Your draft has not been submitted.");
  } catch (error) {
    apiError(error);
  } finally {
    busy(false);
  }
}
async function finishWrite(result) {
  const id = result.id ?? state.selected;
  state.editor.needsReload = true;
  state.editor.baseRaw = Object.fromEntries(
    [...widgets].map(([key, widget]) => [key, widget.raw()]),
  );
  if (result.plaintext) {
    $("#new-token-value").textContent = result.plaintext;
    $("#new-token-panel").hidden = false;
  }
  try {
    await loadData();
    $("#search").value = "";
    const record = records().find((item) => item.id === id) ?? null;
    if (record?.projectId && state.scope && state.scope !== record.projectId) {
      state.scope = record.projectId;
      renderWorkspaceChrome();
    }
    const index = filtered().findIndex((item) => item.id === id);
    state.page = index < 0 ? 1 : Math.floor(index / 20) + 1;
    renderEditor(record);
    flash(
      result.deleted
        ? "Record deleted. Its audit history remains."
        : "Saved. The editor shows the accepted state.",
    );
  } catch (error) {
    state.editor.needsReload = true;
    flash(
      `The change was accepted, but the workspace could not be refreshed. Refresh before another write. ${error.message}`,
      true,
    );
  }
}
form.addEventListener("input", (event) => {
  if (state.busy || event.target.id === "protected-ack") return;
  state.review = null;
  $("#review-panel").hidden = true;
  configureReferences(event.target.name);
  renderProtection();
  syncControls();
});
form.addEventListener("change", (event) => {
  if (state.busy || event.target.id === "protected-ack") return;
  configureReferences(event.target.name);
  renderProtection();
  syncControls();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (
    state.busy ||
    !canWrite() ||
    state.editor.needsReview ||
    state.editor.needsReload
  )
    return;
  let payload;
  try {
    payload = changes();
    if (state.editor.record && !Object.keys(payload).length) {
      flash("There are no changed fields to save.");
      return;
    }
    if (state.kind !== "tokens") payload.confirmation = confirmations();
  } catch (error) {
    apiError(error);
    return;
  }
  const record = state.editor.record;
  busy(true);
  try {
    const { payload: result } = await api(
      `/api/admin/${state.kind}${record ? `/${record.id}` : ""}`,
      {
        method: record ? "PATCH" : "POST",
        body: payload,
        revision: state.editor.revision,
      },
    );
    await finishWrite(result);
  } catch (error) {
    if (error.status === 409 || error.uncertain)
      state.editor.needsReview = true;
    apiError(error);
  } finally {
    busy(false);
  }
});
$("#delete-record").addEventListener("click", async () => {
  if (state.busy || !state.editor.record || !canWrite()) return;
  const record = state.editor.record;
  const action = state.kind === "tokens" ? "Revoke" : "Delete";
  if (
    !confirm(
      `${action} ${displayName(record)}? Referenced records are protected. Unsaved draft changes will be discarded after success.`,
    )
  )
    return;
  let acknowledgment;
  try {
    acknowledgment = confirmations();
    if (state.kind === "projects") {
      const additional = record.environments.filter(
        (item) => item.protectChanges,
      );
      if (
        additional.length &&
        !confirm(
          `This deletion removes configuration for protected environments: ${additional.map((item) => item.name).join(", ")}. Continue?`,
        )
      )
        return;
      acknowledgment = additional.map((item) => `CONFIRM:${item.key}`);
    }
  } catch (error) {
    apiError(error);
    return;
  }
  busy(true);
  try {
    const { payload } = await api(
      `/api/admin/${state.kind}/${record.id}${state.kind === "tokens" ? "/revoke" : ""}`,
      {
        method: state.kind === "tokens" ? "POST" : "DELETE",
        body: state.kind === "tokens" ? {} : { confirmation: acknowledgment },
        revision: state.editor.revision,
      },
    );
    await finishWrite(payload);
  } catch (error) {
    if (error.status === 409 || error.uncertain)
      state.editor.needsReview = true;
    apiError(error);
  } finally {
    busy(false);
  }
});
$("#review-latest").addEventListener("click", reviewLatest);
$("#accept-review").addEventListener("click", () => {
  if (!state.review || state.review.missing || state.busy) return;
  const { latest, draft } = state.review;
  renderEditor(latest, draft);
  flash("Reviewed version accepted. Your changed fields remain unsaved.");
});
$("#discard-draft").addEventListener("click", () => {
  if (!mayLeave()) return;
  renderEditor(records().find((item) => item.id === state.selected) ?? null);
  flash("Draft changes discarded.");
});
$("#new-record").addEventListener("click", () => {
  if (mayLeave()) {
    renderEditor();
    flash("");
  }
});
$("#resource-kind").addEventListener("change", () => {
  const next = $("#resource-kind").value;
  if (!mayLeave()) {
    $("#resource-kind").value = state.kind;
    return;
  }
  state.kind = next;
  state.page = 1;
  $("#search").value = "";
  renderEditor();
  flash("");
});
$("#project-scope").addEventListener("change", () => {
  const next = $("#project-scope").value;
  if (!mayLeave()) {
    $("#project-scope").value = state.scope;
    return;
  }
  state.scope = next;
  state.page = 1;
  renderWorkspaceChrome();
  renderEditor();
});
$("#search").addEventListener("input", () => {
  state.page = 1;
  renderList();
});
$("#previous").addEventListener("click", () => {
  if (state.page > 1) {
    state.page--;
    renderList();
  }
});
$("#next").addEventListener("click", () => {
  state.page++;
  renderList();
});
$("#refresh").addEventListener("click", async () => {
  if (hasDraft() || state.editor?.needsReview) {
    await reviewLatest();
    return;
  }
  if (state.busy) return;
  busy(true);
  try {
    await loadData();
    renderEditor(records().find((item) => item.id === state.selected) ?? null);
    flash("Workspace refreshed.");
  } catch (error) {
    apiError(error);
  } finally {
    busy(false);
  }
});
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  state.token = $("#login-token").value.trim();
  state.generation++;
  state.busy = true;
  $("#login-form button").disabled = true;
  try {
    await loadData();
    $("#login-token").value = "";
    $("#login-panel").hidden = true;
    $("#workspace").hidden = false;
    $("#session").hidden = false;
    renderEditor();
    flash("Connected. Select a record or start a new one.");
  } catch (error) {
    state.token = "";
    state.data = null;
    apiError(error);
  } finally {
    state.busy = false;
    $("#login-form button").disabled = false;
    syncControls();
  }
});
$("#sign-out").addEventListener("click", () => {
  if (!mayLeave()) return;
  state.generation++;
  state.token = "";
  state.data = null;
  state.editor = null;
  state.review = null;
  state.selected = null;
  widgets.clear();
  $("#workspace").hidden = true;
  $("#session").hidden = true;
  $("#login-panel").hidden = false;
  $("#new-token-panel").hidden = true;
  $("#new-token-value").textContent = "";
  $("#fields").replaceChildren();
  $("#record-list").replaceChildren();
  $("#playground-result").textContent = "";
  flash("Signed out. The token was removed from this tab's memory.");
  $("#login-token").focus();
});
$("#dismiss-token").addEventListener("click", () => {
  $("#new-token-value").textContent = "";
  $("#new-token-panel").hidden = true;
});
$("#playground-project").addEventListener("change", configurePlayground);
$("#playground-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  let context;
  try {
    context = JSON.parse($("#context-json").value);
  } catch {
    flash("Context must contain valid JSON.", true);
    return;
  }
  busy(true);
  try {
    const { payload } = await api("/api/admin/playground", {
      method: "POST",
      body: {
        projectId: $("#playground-project").value,
        environmentId: $("#playground-environment").value,
        context,
      },
    });
    $("#playground-result").textContent = JSON.stringify(
      payload.results,
      null,
      2,
    );
    flash("Context evaluated against the accepted configuration.");
  } catch (error) {
    apiError(error);
  } finally {
    busy(false);
  }
});
window.addEventListener("beforeunload", (event) => {
  if (hasDraft()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
