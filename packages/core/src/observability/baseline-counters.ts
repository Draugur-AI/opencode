/**
 * TKT-309: lightweight, additive counters on the paths the reliability redesign will
 * replace, so later adapter-removal decisions ("is anyone still hitting the V1 route?")
 * are measured against real numbers instead of guessed. No behavior change — these are
 * plain in-memory counts, surfaced through the existing structured log stream via
 * Effect.logInfo at each call site, never read back into request handling.
 */

let v1SessionArchiveCalls = 0
let sessionEventFreshSubscribes = 0
let sessionEventReplays = 0
let compactionRuns = 0

export const BaselineCounters = {
  v1SessionArchive: () => ++v1SessionArchiveCalls,
  /** hasCursor: the client passed `after`, i.e. this is a reconnect/replay, not a fresh subscribe. */
  sessionEventSubscribe: (hasCursor: boolean) =>
    hasCursor ? ++sessionEventReplays : ++sessionEventFreshSubscribes,
  compactionRun: () => ++compactionRuns,
  snapshot: () => ({
    v1SessionArchiveCalls,
    sessionEventFreshSubscribes,
    sessionEventReplays,
    compactionRuns,
  }),
}
