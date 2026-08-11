export * as OmittedIdentifierScenario from "./omitted-identifier"

/**
 * Single source of truth for this scenario's inputs (Ethan, TKT-319 PR2 ruling): both arms'
 * scoring functions import from here so they can never drift on WHAT was asked, only differ on
 * WHAT THEY READ OUT of the two different runtimes' responses to it.
 */
export const IDENTIFIER = "10.20.30.40"
export const PORT = "5432"

export const initialPrompt = `The staging database is unreachable at host ${IDENTIFIER} port ${PORT}. Can you look into it?`

/** A realistic lossy summary -- the current arm gets this via a compaction epoch; the baseline
 * arm (pre-slice-4, no durable history to recover from) never produces one, so it has no
 * equivalent step -- its scoring instead checks whether it retains the identifier ANY way at
 * all (raw transcript, its own summarization if it has one) after the same conversation length. */
export const compactionSummary = "User reported the staging database is unreachable. Investigating connectivity."

export const recallPrompt = "What was the exact host and port again?"

export const expectedAnswerFragment = `${IDENTIFIER}:${PORT}`
