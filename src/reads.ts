import { Domain, HttpError, isDomain } from "./contracts";
import { tableForDomain } from "./sync";

const OCCURRED_FIELDS: Record<Domain, readonly string[]> = {
  live: ["targetDate"],
  journal: ["occurredOn"],
  habits: ["occurredOn"],
  setline: ["occurredOn"],
  kith: ["occurredAt", "createdAt"],
  anchor: ["startedAt"],
};

const SEARCH_FIELDS: Record<Domain, readonly string[]> = {
  live: ["title", "status", "category"],
  journal: ["mood"],
  habits: ["name", "status"],
  setline: ["title", "notes"],
  kith: ["personName", "circle", "kind"],
  anchor: ["title"],
};

interface RecordRow {
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  origin_device_id: string;
  payload_json: string;
}

interface EventRow {
  id: string;
  domain: Domain;
  event_type: string;
  entity_id: string;
  occurred_at: string;
  recorded_at: string;
  actor: string;
  summary: string;
}

export interface ReadQuery {
  start?: string;
  end?: string;
  q?: string;
  limit: number;
  offset: number;
  includeSensitive: boolean;
}

export function parseReadQuery(url: URL): ReadQuery {
  const start = optionalDate(url.searchParams.get("start"), "start");
  const end = optionalDate(url.searchParams.get("end"), "end");
  if (start && end && start > end) {
    throw new HttpError(400, "invalid_range", "start must not be after end");
  }
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || undefined;
  return {
    start,
    end,
    q,
    limit: boundedInteger(url.searchParams.get("limit"), 20, 1, 50),
    offset: boundedInteger(url.searchParams.get("offset"), 0, 0, 1_000_000),
    includeSensitive: url.searchParams.get("includeSensitive") === "true",
  };
}

export async function getDomainRecords(
  env: Env,
  userId: string,
  domain: Domain,
  query: ReadQuery,
) {
  const table = tableForDomain(domain);
  const where = ["user_id = ?", "deleted_at IS NULL"];
  const bindings: unknown[] = [userId];
  const occurred = occurredExpression(domain);

  if (query.start) {
    where.push(`${occurred} >= ?`);
    bindings.push(query.start);
  }
  if (query.end) {
    where.push(`${occurred} <= ?`);
    bindings.push(query.end);
  }
  if (query.q) {
    const fields = query.includeSensitive
      ? [...SEARCH_FIELDS[domain], ...sensitiveSearchFields(domain)]
      : SEARCH_FIELDS[domain];
    where.push(`(${fields.map((field) => `COALESCE(json_extract(payload_json, '$.${field}'), '') LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const pattern = `%${escapeLike(query.q)}%`;
    bindings.push(...fields.map(() => pattern));
  }

  const predicate = where.join(" AND ");
  const [rows, total] = await Promise.all([
    env.DB.prepare(
      `SELECT id, created_at, updated_at, version, origin_device_id, payload_json
       FROM ${table}
       WHERE ${predicate}
       ORDER BY ${occurred} DESC, updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, query.limit, query.offset)
      .all<RecordRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${predicate}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  const count = Number(total?.total ?? 0);
  return {
    domain,
    source: "personal-platform",
    generatedAt: new Date().toISOString(),
    items: rows.results.map((row) => ({
      id: row.id,
      occurredAt: occurredAt(domain, row.payload_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      originDeviceId: row.origin_device_id,
      record: projectRecord(domain, JSON.parse(row.payload_json), query.includeSensitive),
    })),
    page: {
      limit: query.limit,
      offset: query.offset,
      total: count,
      nextOffset: query.offset + query.limit < count ? query.offset + query.limit : null,
    },
  };
}

export async function getLifeEvents(env: Env, userId: string, url: URL) {
  const query = parseReadQuery(url);
  const domainValue = url.searchParams.get("domain");
  if (domainValue && !isDomain(domainValue) && domainValue !== "calorie") {
    throw new HttpError(400, "invalid_domain", "domain is not supported");
  }
  const where = ["user_id = ?"];
  const bindings: unknown[] = [userId];
  if (domainValue) {
    where.push("domain = ?");
    bindings.push(domainValue);
  }
  if (query.start) {
    where.push("occurred_at >= ?");
    bindings.push(query.start);
  }
  if (query.end) {
    where.push("occurred_at <= ?");
    bindings.push(query.end);
  }
  if (query.q) {
    where.push("summary LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLike(query.q)}%`);
  }
  const predicate = where.join(" AND ");
  const [events, total] = await Promise.all([
    env.DB.prepare(
      `SELECT id, domain, event_type, entity_id, occurred_at, recorded_at, actor, summary
       FROM life_events WHERE ${predicate}
       ORDER BY occurred_at DESC, recorded_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, query.limit, query.offset)
      .all<EventRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM life_events WHERE ${predicate}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  const count = Number(total?.total ?? 0);
  return {
    source: "personal-platform",
    generatedAt: new Date().toISOString(),
    items: events.results.map((event) => ({
      id: event.id,
      domain: event.domain,
      eventType: event.event_type,
      entityId: event.entity_id,
      occurredAt: event.occurred_at,
      recordedAt: event.recorded_at,
      actor: event.actor,
      summary: event.summary,
    })),
    page: {
      limit: query.limit,
      offset: query.offset,
      total: count,
      nextOffset: query.offset + query.limit < count ? query.offset + query.limit : null,
    },
  };
}

function occurredExpression(domain: Domain): string {
  const paths = OCCURRED_FIELDS[domain].map((field) => `json_extract(payload_json, '$.${field}')`);
  return `COALESCE(${[...paths, "updated_at"].join(", ")})`;
}

function occurredAt(domain: Domain, payloadJson: string): string | null {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  for (const field of OCCURRED_FIELDS[domain]) {
    if (typeof payload[field] === "string") return payload[field] as string;
  }
  return null;
}

export function projectRecord(
  domain: Domain,
  record: Record<string, unknown>,
  includeSensitive: boolean,
): Record<string, unknown> {
  if (includeSensitive) return record;
  switch (domain) {
    case "journal":
      return select(record, ["sourceId", "occurredOn", "mood"]);
    case "kith":
      return select(record, [
        "recordType",
        "personId",
        "personName",
        "circle",
        "closeness",
        "hue",
        "birthday",
        "kind",
        "occurredAt",
        "followUpAt",
        "createdAt",
      ]);
    case "live":
      return select(record, ["title", "status", "targetDate", "category"]);
    default:
      return record;
  }
}

function sensitiveSearchFields(domain: Domain): readonly string[] {
  switch (domain) {
    case "journal": return ["body", "morningReflection", "eveningReflection", "newThing"];
    case "kith": return ["howWeMet", "standingNotes", "note"];
    case "live": return ["notes"];
    default: return [];
  }
}

function select(record: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(fields.flatMap((field) =>
    record[field] === undefined ? [] : [[field, record[field]]],
  ));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function optionalDate(value: string | null, label: string): string | undefined {
  if (!value) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "invalid_range", `${label} must be an ISO-8601 date`);
  }
  return value;
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "invalid_pagination", `value must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
