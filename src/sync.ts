import {
  AppliedChange,
  ConflictChange,
  Domain,
  HttpError,
  Mutation,
  PushRequest,
  PushResult,
} from "./contracts";

const TABLES: Record<Domain, string> = {
  live: "live_records",
  journal: "journal_records",
  habits: "habits_records",
  setline: "setline_records",
  kith: "kith_records",
  anchor: "anchor_records",
};

interface StoredRecordRow {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  origin_device_id: string;
  payload_json: string;
}

interface DuplicateRow {
  record_id: string;
  result_version: number;
  cursor: number;
}

interface CursorRow {
  cursor: number;
}

export interface ActionAudit {
  id: string;
  toolName: string;
  input: unknown;
  originalInstruction: string;
  undoPayload: unknown;
}

export interface AppliedMutation {
  result: PushResult;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function pushMutations(
  env: Env,
  userId: string,
  request: PushRequest,
): Promise<PushResult[]> {
  await registerDevice(env, userId, request.deviceId);
  const results: PushResult[] = [];
  for (const mutation of request.mutations) {
    const applied = await applyMutation(
      env,
      userId,
      request.domain,
      request.deviceId,
      mutation,
    );
    results.push(applied.result);
  }
  return results;
}

export async function applyMutation(
  env: Env,
  userId: string,
  domain: Domain,
  deviceId: string,
  mutation: Mutation,
  audit?: ActionAudit,
): Promise<AppliedMutation> {
  const duplicate = await findDuplicate(env, userId, mutation.idempotencyKey);
  if (duplicate) {
    return {
      result: duplicateResult(mutation, duplicate),
      before: null,
      after: null,
    };
  }

  const table = TABLES[domain];
  const current = await getStoredRecord(env, table, userId, mutation.id);
  if ((!current && mutation.baseVersion !== 0) || (current && current.version !== mutation.baseVersion)) {
    return {
      result: conflictResult(mutation, current?.version ?? null),
      before: current ? parsePayload(current.payload_json) : null,
      after: null,
    };
  }

  const now = new Date().toISOString();
  const version = (current?.version ?? 0) + 1;
  const changeId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const payload =
    mutation.operation === "delete"
      ? current
        ? parsePayload(current.payload_json)
        : {}
      : (mutation.record as Record<string, unknown>);
  const payloadJson = JSON.stringify(payload);
  const deletedAt = mutation.operation === "delete" ? now : null;
  const createdAt = current?.created_at ?? now;
  const eventType = `${domain}.${audit?.toolName ?? (mutation.operation === "delete" ? "deleted" : "updated")}`;
  const summary = audit?.originalInstruction ?? `${domain} record ${mutation.operation}`;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO ${table}
       (id, user_id, created_at, updated_at, deleted_at, version, origin_device_id, sync_token, payload_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(user_id, id) DO UPDATE SET
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         version = excluded.version,
         origin_device_id = excluded.origin_device_id,
         sync_token = excluded.sync_token,
         payload_json = excluded.payload_json
       WHERE ${table}.version = ?10`,
    ).bind(
      mutation.id,
      userId,
      createdAt,
      now,
      deletedAt,
      version,
      deviceId,
      changeId,
      payloadJson,
      mutation.baseVersion,
    ),
    env.DB.prepare(
      `INSERT INTO sync_changes
       (change_id, user_id, domain, record_id, operation, version, occurred_at,
        recorded_at, origin_device_id, payload_json, idempotency_key)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
       FROM ${table}
       WHERE user_id = ?2 AND id = ?4 AND sync_token = ?1`,
    ).bind(
      changeId,
      userId,
      domain,
      mutation.id,
      mutation.operation,
      version,
      mutation.occurredAt,
      now,
      deviceId,
      payloadJson,
      mutation.idempotencyKey,
    ),
    env.DB.prepare(
      `INSERT INTO life_events
       (id, user_id, domain, event_type, entity_id, occurred_at, recorded_at, actor, summary, metadata_json)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       FROM ${table}
       WHERE user_id = ?2 AND id = ?5 AND sync_token = ?11`,
    ).bind(
      eventId,
      userId,
      domain,
      eventType,
      mutation.id,
      mutation.occurredAt,
      now,
      audit ? "assistant" : "application",
      summary,
      JSON.stringify({ operation: mutation.operation, version, deviceId }),
      changeId,
    ),
    env.DB.prepare(
      `INSERT INTO idempotency_keys
       (user_id, idempotency_key, domain, record_id, change_id, result_version, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       FROM ${table}
       WHERE user_id = ?1 AND id = ?4 AND sync_token = ?5`,
    ).bind(
      userId,
      mutation.idempotencyKey,
      domain,
      mutation.id,
      changeId,
      version,
      now,
    ),
  ];

  if (audit) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO pace_actions
         (id, user_id, domain, tool_name, input_json, original_instruction,
          idempotency_key, status, created_at, completed_at, before_json,
          after_json, undo_payload)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'completed', ?8, ?8, ?9, ?10, ?11
         FROM ${table}
         WHERE user_id = ?2 AND id = ?12 AND sync_token = ?13`,
      ).bind(
        audit.id,
        userId,
        domain,
        audit.toolName,
        JSON.stringify(audit.input),
        audit.originalInstruction,
        mutation.idempotencyKey,
        now,
        current ? current.payload_json : null,
        mutation.operation === "delete" ? null : payloadJson,
        JSON.stringify(audit.undoPayload),
        mutation.id,
        changeId,
      ),
    );
  }

  try {
    const batch = await env.DB.batch(statements);
    if ((batch[0]?.meta.changes ?? 0) === 0) {
      const latest = await getStoredRecord(env, table, userId, mutation.id);
      return {
        result: conflictResult(mutation, latest?.version ?? null),
        before: latest ? parsePayload(latest.payload_json) : null,
        after: null,
      };
    }
  } catch (error) {
    const accepted = await findDuplicate(env, userId, mutation.idempotencyKey);
    if (accepted) {
      return {
        result: duplicateResult(mutation, accepted),
        before: null,
        after: null,
      };
    }
    throw error;
  }

  const cursor = await env.DB.prepare(
    "SELECT cursor FROM sync_changes WHERE change_id = ?1",
  )
    .bind(changeId)
    .first<CursorRow>();
  if (!cursor) {
    throw new HttpError(500, "sync_write_incomplete", "accepted mutation has no cursor");
  }

  return {
    result: {
      id: mutation.id,
      idempotencyKey: mutation.idempotencyKey,
      status: "accepted",
      version,
      cursor: cursor.cursor,
    },
    before: current ? parsePayload(current.payload_json) : null,
    after: mutation.operation === "delete" ? null : payload,
  };
}

export async function pullChanges(
  env: Env,
  userId: string,
  domain: Domain,
  cursor: number,
): Promise<{ changes: unknown[]; cursor: number; hasMore: boolean }> {
  const result = await env.DB.prepare(
    `SELECT cursor, change_id AS changeId, domain, record_id AS id, operation,
            version, occurred_at AS occurredAt, recorded_at AS recordedAt,
            origin_device_id AS originDeviceId, payload_json AS payloadJson
     FROM sync_changes
     WHERE user_id = ?1 AND domain = ?2 AND cursor > ?3
     ORDER BY cursor ASC
     LIMIT 501`,
  )
    .bind(userId, domain, cursor)
    .all<{
      cursor: number;
      changeId: string;
      domain: Domain;
      id: string;
      operation: string;
      version: number;
      occurredAt: string;
      recordedAt: string;
      originDeviceId: string;
      payloadJson: string;
    }>();
  const hasMore = result.results.length > 500;
  const page = result.results.slice(0, 500).map(({ payloadJson, ...row }) => ({
    ...row,
    record: JSON.parse(payloadJson) as unknown,
  }));
  return {
    changes: page,
    cursor: page.at(-1)?.cursor ?? cursor,
    hasMore,
  };
}

export async function getRecord(
  env: Env,
  userId: string,
  domain: Domain,
  id: string,
): Promise<StoredRecordRow | null> {
  return getStoredRecord(env, TABLES[domain], userId, id);
}

export function tableForDomain(domain: Domain): string {
  return TABLES[domain];
}

async function registerDevice(env: Env, userId: string, deviceId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, platform, last_seen_at, created_at)
     VALUES (?1, ?2, 'unknown', ?3, ?3)
     ON CONFLICT(user_id, id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(deviceId, userId, now)
    .run();
}

async function getStoredRecord(
  env: Env,
  table: string,
  userId: string,
  id: string,
): Promise<StoredRecordRow | null> {
  return env.DB.prepare(
    `SELECT id, created_at, updated_at, deleted_at, version, origin_device_id, payload_json
     FROM ${table} WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(userId, id)
    .first<StoredRecordRow>();
}

async function findDuplicate(
  env: Env,
  userId: string,
  idempotencyKey: string,
): Promise<DuplicateRow | null> {
  return env.DB.prepare(
    `SELECT i.record_id, i.result_version, c.cursor
     FROM idempotency_keys i
     JOIN sync_changes c ON c.change_id = i.change_id
     WHERE i.user_id = ?1 AND i.idempotency_key = ?2`,
  )
    .bind(userId, idempotencyKey)
    .first<DuplicateRow>();
}

function duplicateResult(mutation: Mutation, duplicate: DuplicateRow): AppliedChange {
  return {
    id: duplicate.record_id,
    idempotencyKey: mutation.idempotencyKey,
    status: "duplicate",
    version: duplicate.result_version,
    cursor: duplicate.cursor,
  };
}

function conflictResult(mutation: Mutation, actualVersion: number | null): ConflictChange {
  return {
    id: mutation.id,
    idempotencyKey: mutation.idempotencyKey,
    status: "conflict",
    expectedVersion: mutation.baseVersion,
    actualVersion,
  };
}

function parsePayload(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}
