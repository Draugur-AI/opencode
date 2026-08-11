import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal } from "solid-js"
import * as SessionEntities from "./session-entities"

/**
 * Holds the one client-side truth about session existence and lifecycle, and hands out the reads
 * every consumer uses instead of keeping its own copy.
 *
 * The reducer in `session-entities.ts` is where the rules live and is deliberately free of Solid;
 * this is the thin reactive shell around it. Keeping them apart is what lets the property tests
 * drive the rules through thousands of generated deliveries without a DOM.
 *
 * Nothing here talks to a server. Feeding it — bootstrap snapshots, session event streams,
 * reconnects — is the caller's job, so a test can drive the exact delivery order it wants.
 */
export const { use: useSessionEntities, provider: SessionEntitiesProvider } = createSimpleContext({
  name: "SessionEntities",
  gate: false,
  init: () => {
    const [state, setState] = createSignal<SessionEntities.EntityState>(SessionEntities.empty)

    const dispatch = (message: SessionEntities.Message) => {
      setState((current) => SessionEntities.reduce(current, message))
    }

    return {
      get state() {
        return state()
      },
      dispatch,
      /** Entity for one session, or undefined if this client has never heard of it. */
      get: (serverKey: string, sessionID: string) => SessionEntities.get(state(), serverKey, sessionID),
      /**
       * Whether a session belongs in normal active views. Components ask this instead of reading a
       * lifecycle field themselves, so "what counts as active" has exactly one definition.
       */
      isActive: (serverKey: string, sessionID: string) =>
        SessionEntities.get(state(), serverKey, sessionID)?.value?.lifecycle.state === "active",
      /**
       * Keys the reducer could not explain — a sequence gap, or a transition the lifecycle forbids.
       * The owner re-snapshots these and then clears them; a client that guessed instead is what
       * this store replaces.
       */
      get needsReconcile() {
        return state().reconcile
      },
      reconciled: (keys: readonly SessionEntities.EntityKey[]) => dispatch({ type: "reconciled", keys }),
    }
  },
})
