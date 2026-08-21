export const DOMAINS = [
  "live",
  "journal",
  "habits",
  "setline",
  "kith",
  "anchor",
] as const;

export type Domain = (typeof DOMAINS)[number];
export type MutationOperation = "upsert" | "delete";

export interface Mutation {
  id: string;
  idempotencyKey: string;
  operation: MutationOperation;
  baseVersion: number;
  occurredAt: string;
  record?: unknown;
}

export interface PushRequest {
  domain: Domain;
  deviceId: string;
  mutations: Mutation[];
}

export interface AppliedChange {
  id: string;
  idempotencyKey: string;
  status: "accepted" | "duplicate";
  version: number;
  cursor: number;
}

export interface ConflictChange {
  id: string;
  idempotencyKey: string;
  status: "conflict";
  expectedVersion: number;
  actualVersion: number | null;
}

export type PushResult = AppliedChange | ConflictChange;

export interface AuthenticatedUser {
  id: string;
  appleSubject?: string;
  email?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && DOMAINS.includes(value as Domain);
}

export function requireObject(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  label: string,
  maximumLength = 10_000,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", `${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new HttpError(400, "invalid_request", `${label} is too long`);
  }
  return trimmed;
}

export function optionalString(
  value: unknown,
  label: string,
  maximumLength = 10_000,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, label, maximumLength);
}

export function requireIsoDate(value: unknown, label: string): string {
  const date = requireString(value, label, 64);
  if (Number.isNaN(Date.parse(date))) {
    throw new HttpError(400, "invalid_request", `${label} must be an ISO-8601 date`);
  }
  return date;
}

export function optionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireIsoDate(value, label);
}

export function requireInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new HttpError(400, "invalid_request", `${label} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function requireEnum<T extends string>(
  value: unknown,
  label: string,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new HttpError(400, "invalid_request", `${label} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

export function validateDomainRecord(
  domain: Domain,
  value: unknown,
): Record<string, unknown> {
  const input = requireObject(value, "record");
  switch (domain) {
    case "live":
      return compact({
        title: requireString(input.title, "record.title", 240),
        status: requireEnum(input.status, "record.status", [
          "planned",
          "in_progress",
          "completed",
        ] as const),
        targetDate: optionalIsoDate(input.targetDate, "record.targetDate"),
        notes: optionalString(input.notes, "record.notes", 20_000),
      });
    case "journal":
      return compact({
        body: requireString(input.body, "record.body", 100_000),
        occurredOn: requireIsoDate(input.occurredOn, "record.occurredOn"),
        mood: optionalString(input.mood, "record.mood", 80),
      });
    case "habits":
      return compact({
        habitId: requireString(input.habitId, "record.habitId", 128),
        name: requireString(input.name, "record.name", 240),
        occurredOn: requireIsoDate(input.occurredOn, "record.occurredOn"),
        status: requireEnum(input.status, "record.status", [
          "completed",
          "skipped",
          "planned",
        ] as const),
      });
    case "setline":
      return compact({
        title: requireString(input.title, "record.title", 240),
        occurredOn: requireIsoDate(input.occurredOn, "record.occurredOn"),
        minutes: requireInteger(input.minutes, "record.minutes"),
        notes: optionalString(input.notes, "record.notes", 10_000),
      });
    case "kith":
      return compact({
        personId: requireString(input.personId, "record.personId", 128),
        personName: requireString(input.personName, "record.personName", 240),
        kind: requireString(input.kind, "record.kind", 80),
        occurredAt: requireIsoDate(input.occurredAt, "record.occurredAt"),
        note: optionalString(input.note, "record.note", 20_000),
        followUpAt: optionalIsoDate(input.followUpAt, "record.followUpAt"),
      });
    case "anchor":
      return compact({
        title: requireString(input.title, "record.title", 240),
        startedAt: requireIsoDate(input.startedAt, "record.startedAt"),
        endedAt: optionalIsoDate(input.endedAt, "record.endedAt"),
        durationSeconds: requireInteger(input.durationSeconds, "record.durationSeconds"),
        interruptionCount: requireInteger(
          input.interruptionCount,
          "record.interruptionCount",
        ),
      });
  }
}

export function parsePushRequest(value: unknown): PushRequest {
  const input = requireObject(value);
  if (!isDomain(input.domain)) {
    throw new HttpError(400, "invalid_domain", "domain is not supported");
  }
  const domain = input.domain;
  const deviceId = requireString(input.deviceId, "deviceId", 128);
  if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
    throw new HttpError(400, "invalid_request", "mutations must be a non-empty array");
  }
  if (input.mutations.length > 100) {
    throw new HttpError(400, "invalid_request", "a push can contain at most 100 mutations");
  }
  const mutations = input.mutations.map((value, index): Mutation => {
    const mutation = requireObject(value, `mutations[${index}]`);
    const operation = requireEnum(mutation.operation, `mutations[${index}].operation`, [
      "upsert",
      "delete",
    ] as const);
    return {
      id: requireString(mutation.id, `mutations[${index}].id`, 128),
      idempotencyKey: requireString(
        mutation.idempotencyKey,
        `mutations[${index}].idempotencyKey`,
        200,
      ),
      operation,
      baseVersion: requireInteger(mutation.baseVersion, `mutations[${index}].baseVersion`),
      occurredAt: requireIsoDate(mutation.occurredAt, `mutations[${index}].occurredAt`),
      record:
        operation === "upsert"
          ? validateDomainRecord(domain, mutation.record)
          : mutation.record,
    };
  });
  return { domain, deviceId, mutations };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
