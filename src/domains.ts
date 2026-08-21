import {
  Domain,
  DOMAINS,
  HttpError,
  optionalIsoDate,
  optionalString,
  requireInteger,
  requireIsoDate,
  requireObject,
  requireString,
  validateDomainRecord,
} from "./contracts";
import { ActionAudit, applyMutation, getRecord, tableForDomain } from "./sync";
import { projectRecord } from "./reads";

const PLATFORM_SUMMARY_DOMAINS = DOMAINS.filter((domain) => domain !== "live");

const ACTIONS: Record<Domain, readonly string[]> = {
  live: ["add_item"],
  journal: ["add_entry"],
  habits: ["check_in"],
  setline: ["record_activity"],
  kith: ["record_interaction"],
  anchor: ["record_session"],
};

const SUGGESTIONS: Record<Domain, string> = {
  live: "Choose one planned experience to move forward.",
  journal: "Write a short entry about today.",
  habits: "Check in on today's habits.",
  setline: "Record the activity you completed.",
  kith: "Record a recent interaction or follow-up.",
  anchor: "Record a focused session and its interruptions.",
};

interface SummaryRow {
  active_count: number;
  last_updated_at: string | null;
  latest_payload: string | null;
}

interface ActionRow {
  id: string;
  status: string;
  completed_at: string | null;
}

interface AuditRow {
  id: string;
  domain: Domain;
  tool_name: string;
  original_instruction: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  before_json: string | null;
  after_json: string | null;
  undo_payload: string | null;
  undone_at: string | null;
}

export function getAvailableActions(domain: Domain): readonly string[] {
  return ACTIONS[domain];
}

export async function getDomainSummary(env: Env, userId: string, domain: Domain) {
  const table = tableForDomain(domain);
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS active_count,
       MAX(updated_at) AS last_updated_at,
       (SELECT payload_json FROM ${table}
        WHERE user_id = ?1 AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1) AS latest_payload
     FROM ${table}
     WHERE user_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(userId)
    .first<SummaryRow>();
  return summaryFromRow(domain, row);
}

export async function getToday(env: Env, userId: string) {
  const statements = PLATFORM_SUMMARY_DOMAINS.map((domain) => {
    const table = tableForDomain(domain);
    return env.DB.prepare(
      `SELECT
         COUNT(*) AS active_count,
         MAX(updated_at) AS last_updated_at,
         (SELECT payload_json FROM ${table}
          WHERE user_id = ?1 AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 1) AS latest_payload
       FROM ${table}
       WHERE user_id = ?1 AND deleted_at IS NULL`,
    ).bind(userId);
  });
  const rows = await env.DB.batch<SummaryRow>(statements);
  return {
    generatedAt: new Date().toISOString(),
    source: "personal-platform",
    summaries: PLATFORM_SUMMARY_DOMAINS.map((domain, index) =>
      summaryFromRow(domain, rows[index]?.results[0] ?? null),
    ),
  };
}

export async function executeAction(
  env: Env,
  userId: string,
  domain: Domain,
  action: string,
  body: unknown,
) {
  if (!ACTIONS[domain].includes(action)) {
    throw new HttpError(404, "unknown_action", `${domain}.${action} is not available`);
  }
  const request = requireObject(body);
  const idempotencyKey = requireString(request.idempotencyKey, "idempotencyKey", 200);
  const existingAction = await findAction(env, userId, idempotencyKey);
  if (existingAction) {
    return {
      actionId: existingAction.id,
      status: existingAction.status,
      completedAt: existingAction.completed_at,
      duplicate: true,
    };
  }

  const deviceId = requireString(request.deviceId, "deviceId", 128);
  const originalInstruction = requireString(
    request.originalInstruction,
    "originalInstruction",
    10_000,
  );
  const input = requireObject(request.input, "input");
  const actionId = crypto.randomUUID();
  const recordId = optionalString(request.recordId, "recordId", 128) ?? crypto.randomUUID();
  const occurredAt = actionOccurredAt(domain, input);
  const record = validateDomainRecord(domain, actionRecord(domain, action, input));
  const audit: ActionAudit = {
    id: actionId,
    toolName: action,
    input,
    originalInstruction,
    undoPayload: { domain, recordId, operation: "delete" },
  };
  const applied = await applyMutation(
    env,
    userId,
    domain,
    deviceId,
    {
      id: recordId,
      idempotencyKey,
      operation: "upsert",
      baseVersion: 0,
      occurredAt,
      record,
    },
    audit,
  );
  if (applied.result.status === "conflict") {
    await recordFailedAction(env, userId, domain, action, request, actionId, idempotencyKey);
    throw new HttpError(409, "conflict", "the action targeted an existing record", applied.result);
  }
  if (applied.result.status === "duplicate") {
    const acceptedAction = await findAction(env, userId, idempotencyKey);
    if (!acceptedAction) {
      throw new HttpError(
        409,
        "idempotency_key_reused",
        "the idempotency key belongs to a non-action mutation",
      );
    }
    return {
      actionId: acceptedAction.id,
      status: acceptedAction.status,
      completedAt: acceptedAction.completed_at,
      duplicate: true,
      change: applied.result,
    };
  }
  return {
    actionId,
    status: "completed",
    completedAt: new Date().toISOString(),
    change: applied.result,
    undo: { available: true, actionId },
  };
}

export async function undoAction(env: Env, userId: string, actionId: string) {
  const action = await env.DB.prepare(
    `SELECT id, domain, tool_name, original_instruction, status, created_at,
            completed_at, before_json, after_json, undo_payload, undone_at
     FROM pace_actions WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(userId, actionId)
    .first<AuditRow>();
  if (!action) throw new HttpError(404, "action_not_found", "action was not found");
  if (action.undone_at) {
    return { actionId, status: "undone", undoneAt: action.undone_at, duplicate: true };
  }
  if (!action.undo_payload) {
    throw new HttpError(409, "undo_unavailable", "this action cannot be undone");
  }
  const undo = requireObject(JSON.parse(action.undo_payload), "undo payload");
  if (undo.operation !== "delete" || typeof undo.recordId !== "string") {
    throw new HttpError(409, "undo_unavailable", "the stored undo operation is invalid");
  }
  const current = await getRecord(env, userId, action.domain, undo.recordId);
  if (!current || current.deleted_at) {
    const undoneAt = new Date().toISOString();
    await markUndone(env, userId, actionId, undoneAt);
    return { actionId, status: "undone", undoneAt, duplicate: true };
  }
  const undoActionId = crypto.randomUUID();
  const applied = await applyMutation(
    env,
    userId,
    action.domain,
    "personal-platform",
    {
      id: undo.recordId,
      idempotencyKey: `undo:${actionId}`,
      operation: "delete",
      baseVersion: current.version,
      occurredAt: new Date().toISOString(),
    },
    {
      id: undoActionId,
      toolName: `undo_${action.tool_name}`,
      input: { actionId },
      originalInstruction: `Undo: ${action.original_instruction}`,
      undoPayload: null,
    },
  );
  if (applied.result.status === "conflict") {
    throw new HttpError(409, "conflict", "the record changed before undo", applied.result);
  }
  const undoneAt = new Date().toISOString();
  await markUndone(env, userId, actionId, undoneAt);
  return { actionId, undoActionId, status: "undone", undoneAt };
}

export async function getActivity(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, domain, tool_name, original_instruction, status, created_at,
            completed_at, before_json, after_json, undo_payload, undone_at
     FROM pace_actions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all<AuditRow>();
  return rows.results.map((row) => ({
    id: row.id,
    domain: row.domain,
    toolName: row.tool_name,
    originalInstruction: row.original_instruction,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    before: parseNullable(row.before_json),
    after: parseNullable(row.after_json),
    undo: row.undo_payload ? { available: !row.undone_at, payload: JSON.parse(row.undo_payload) } : null,
    undoneAt: row.undone_at,
  }));
}

function actionRecord(
  domain: Domain,
  _action: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (domain) {
    case "live":
      return {
        title: input.title,
        status: input.status ?? "planned",
        targetDate: input.targetDate,
        notes: input.notes,
      };
    case "journal":
      return { body: input.body, occurredOn: input.occurredOn, mood: input.mood };
    case "habits":
      return {
        habitId: input.habitId,
        name: input.name,
        occurredOn: input.occurredOn,
        status: input.status ?? "completed",
      };
    case "setline":
      return {
        title: input.title,
        occurredOn: input.occurredOn,
        minutes: requireInteger(input.minutes, "input.minutes"),
        notes: input.notes,
      };
    case "kith":
      return {
        recordType: "interaction",
        personId: input.personId,
        personName: input.personName,
        kind: input.kind ?? "conversation",
        occurredAt: input.occurredAt,
        note: input.note,
        followUpAt: input.followUpAt,
      };
    case "anchor":
      return {
        title: input.title,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds: requireInteger(input.durationSeconds, "input.durationSeconds"),
        interruptionCount: requireInteger(
          input.interruptionCount ?? 0,
          "input.interruptionCount",
        ),
      };
  }
}

function actionOccurredAt(domain: Domain, input: Record<string, unknown>): string {
  switch (domain) {
    case "journal":
    case "habits":
    case "setline":
      return requireIsoDate(input.occurredOn, "input.occurredOn");
    case "kith":
      return requireIsoDate(input.occurredAt, "input.occurredAt");
    case "anchor":
      return requireIsoDate(input.startedAt, "input.startedAt");
    case "live":
      optionalIsoDate(input.targetDate, "input.targetDate");
      return new Date().toISOString();
  }
}

function summaryFromRow(domain: Domain, row: SummaryRow | null) {
  const latest = row?.latest_payload
    ? projectRecord(domain, JSON.parse(row.latest_payload), false)
    : null;
  return {
    domain,
    activeCount: row?.active_count ?? 0,
    latest,
    lastUpdatedAt: row?.last_updated_at ?? null,
    source: "personal-platform",
    suggestedAction: SUGGESTIONS[domain],
    availableActions: ACTIONS[domain],
  };
}

async function findAction(
  env: Env,
  userId: string,
  idempotencyKey: string,
): Promise<ActionRow | null> {
  return env.DB.prepare(
    "SELECT id, status, completed_at FROM pace_actions WHERE user_id = ?1 AND idempotency_key = ?2",
  )
    .bind(userId, idempotencyKey)
    .first<ActionRow>();
}

async function recordFailedAction(
  env: Env,
  userId: string,
  domain: Domain,
  toolName: string,
  input: unknown,
  actionId: string,
  idempotencyKey: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO pace_actions
     (id, user_id, domain, tool_name, input_json, original_instruction,
      idempotency_key, status, created_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'Action failed before applying', ?6, 'failed', ?7, ?7)`,
  )
    .bind(actionId, userId, domain, toolName, JSON.stringify(input), idempotencyKey, now)
    .run();
}

async function markUndone(
  env: Env,
  userId: string,
  actionId: string,
  undoneAt: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE pace_actions SET status = 'undone', undone_at = ?1 WHERE user_id = ?2 AND id = ?3",
  )
    .bind(undoneAt, userId, actionId)
    .run();
}

function parseNullable(value: string | null): unknown {
  return value ? JSON.parse(value) : null;
}
