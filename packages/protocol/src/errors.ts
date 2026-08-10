import { Schema } from "effect"

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "ConflictError",
  {
    message: Schema.String,
    resource: Schema.optional(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
  },
  { httpApiStatus: 503 },
) {}

export class UnknownError extends Schema.TaggedErrorClass<UnknownError>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  },
  { httpApiStatus: 500 },
) {}

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "ProviderNotFoundError",
  {
    providerID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "MessageNotFoundError",
  {
    sessionID: Schema.String,
    messageID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

/**
 * A lifecycle mutation lost to a concurrent one, or carried a stale `expectedLifecycleRevision`.
 * Carries the revision the session actually holds so a client can retry without a second read.
 */
export class SessionLifecycleConflictError extends Schema.TaggedErrorClass<SessionLifecycleConflictError>()(
  "SessionLifecycleConflictError",
  {
    sessionID: Schema.String,
    lifecycleRevision: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** The requested lifecycle transition is not legal from the state the session is in. */
export class SessionLifecycleTransitionError extends Schema.TaggedErrorClass<SessionLifecycleTransitionError>()(
  "SessionLifecycleTransitionError",
  {
    sessionID: Schema.String,
    from: Schema.String,
    to: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/**
 * A goal mutation lost to a concurrent one, or carried a stale `expectedVersion`. Carries the
 * version the goal actually holds so a client can retry without a second read.
 */
export class SessionGoalConflictError extends Schema.TaggedErrorClass<SessionGoalConflictError>()(
  "SessionGoalConflictError",
  {
    sessionID: Schema.String,
    version: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** The session has no goal set yet -- distinct from SessionNotFoundError, since the session itself
 * exists. */
export class SessionGoalNotSetError extends Schema.TaggedErrorClass<SessionGoalNotSetError>()(
  "SessionGoalNotSetError",
  { sessionID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** The working ledger is at its bounded budget; the caller must supersede an entry before adding
 * another one. Never silently dropped -- see the design post's ledger cap policy. */
export class SessionLedgerCapExceededError extends Schema.TaggedErrorClass<SessionLedgerCapExceededError>()(
  "SessionLedgerCapExceededError",
  {
    sessionID: Schema.String,
    activeCount: Schema.Int,
    activeBytes: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** No active ledger entry with this ID -- either it never existed or it is already superseded. */
export class SessionLedgerEntryNotFoundError extends Schema.TaggedErrorClass<SessionLedgerEntryNotFoundError>()(
  "SessionLedgerEntryNotFoundError",
  {
    sessionID: Schema.String,
    entryID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

/**
 * The session was permanently deleted. Distinct from 404 on purpose: a client that cannot tell
 * "deleted" from "not fetched yet" will keep a tab open on a session that no longer exists.
 */
export class SessionPurgedError extends Schema.TaggedErrorClass<SessionPurgedError>()(
  "SessionPurgedError",
  {
    sessionID: Schema.String,
    purgedAt: Schema.Finite,
    lastLifecycleRevision: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 410 },
) {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()(
  "InvalidCursorError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class PermissionNotFoundError extends Schema.TaggedErrorClass<PermissionNotFoundError>()(
  "PermissionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class QuestionNotFoundError extends Schema.TaggedErrorClass<QuestionNotFoundError>()(
  "QuestionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
  "ForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
  "PtyNotFoundError",
  {
    ptyID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
