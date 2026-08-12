import { createEffect, createMemo, createSignal, For, Show, on } from "solid-js"
import type { JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextField } from "@opencode-ai/ui/text-field"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type {
  ServerGoalGetOutput,
  ServerGoalUpdateOutput,
  ServerLedgerListOutput,
} from "@opencode-ai/client-next"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createGoalLedgerClient } from "@/utils/goal-ledger-client"
import { showToast } from "@/utils/toast"
import { errorMessage } from "@/pages/layout/helpers"

type Criterion = ServerGoalUpdateOutput["acceptanceCriteria"][number]
type Constraint = ServerGoalUpdateOutput["constraints"][number]
type GoalStatus = ServerGoalUpdateOutput["status"]
type LedgerEntry = ServerLedgerListOutput[number]

const newID = () => crypto.randomUUID()

/** Draft shape for the editable form -- deliberately plain arrays, not the readonly wire type. */
type GoalDraft = {
  objective: string
  acceptanceCriteria: Criterion[]
  constraints: Constraint[]
}

const draftFromGoal = (goal: ServerGoalGetOutput): GoalDraft => ({
  objective: goal?.objective ?? "",
  acceptanceCriteria: goal ? goal.acceptanceCriteria.map((c) => ({ ...c })) : [],
  constraints: goal ? goal.constraints.map((c) => ({ ...c })) : [],
})

function StatusBadge(props: { status: GoalStatus | Criterion["status"] }) {
  const variant = createMemo<"neutral" | "accent">(() =>
    props.status === "achieved" || props.status === "met" ? "accent" : "neutral",
  )
  return <Tag variant={variant()}>{props.status}</Tag>
}

/**
 * The goal + ledger side panel (TKT-335). Human-only surface: the agent's own goal/ledger
 * mutations go through the narrowly-scoped `goal_update_progress`/`ledger_add` tools server-side
 * (TKT-317), which already refuse to rewrite the objective or waive a criterion -- this panel is
 * simply where the one caller who IS allowed to do those things (the user, over HTTP) does so.
 * There is no agent-authored variant of this component to gate against.
 */
export function SessionGoalTab() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const { params, view } = useSessionLayout()

  const [loading, setLoading] = createSignal(true)
  const [goal, setGoal] = createSignal<ServerGoalGetOutput>(null)
  const [ledger, setLedger] = createSignal<LedgerEntry[]>([])
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal<GoalDraft>(draftFromGoal(null))
  const [saving, setSaving] = createSignal(false)
  const [supersedingID, setSupersedingID] = createSignal<string>()
  const [supersedeText, setSupersedeText] = createSignal("")

  /**
   * `ServerConnection.Any` in, unconditionally -- sidecar and ssh connections carry a usable
   * `.http` just like a direct one, so there is nothing to narrow here. Silently bailing out on
   * a non-"http" `.type` was exactly the bug shape TKT-349 eliminated elsewhere in this app: the
   * panel would never load and every save would no-op with no error and no toast. A real failure
   * (network, auth, connection down) surfaces through the try/catch below instead.
   */
  const client = () => createGoalLedgerClient(sdk().server)

  const load = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const c = client()
    setLoading(true)
    try {
      const [nextGoal, nextLedger] = await Promise.all([
        c.serverGoal.get({ sessionID }),
        c.serverLedger.list({ sessionID, status: "active" }),
      ])
      setGoal(nextGoal ?? null)
      setLedger([...nextLedger])
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => params.id, load))

  const startEditing = () => {
    setDraft(draftFromGoal(goal()))
    setEditing(true)
  }

  const cancelEditing = () => setEditing(false)

  const setCriterionStatus = (id: string, status: Criterion["status"]) => {
    setDraft((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.map((c) => (c.id === id ? { ...c, status } : c)),
    }))
  }

  const removeCriterion = (id: string) => {
    setDraft((prev) => ({ ...prev, acceptanceCriteria: prev.acceptanceCriteria.filter((c) => c.id !== id) }))
  }

  const addCriterion = () => {
    setDraft((prev) => ({
      ...prev,
      acceptanceCriteria: [...prev.acceptanceCriteria, { id: newID(), text: "", status: "open" }],
    }))
  }

  const setCriterionText = (id: string, text: string) => {
    setDraft((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.map((c) => (c.id === id ? { ...c, text } : c)),
    }))
  }

  const removeConstraint = (id: string) => {
    setDraft((prev) => ({ ...prev, constraints: prev.constraints.filter((c) => c.id !== id) }))
  }

  const addConstraint = () => {
    setDraft((prev) => ({ ...prev, constraints: [...prev.constraints, { id: newID(), text: "" }] }))
  }

  const setConstraintText = (id: string, text: string) => {
    setDraft((prev) => ({
      ...prev,
      constraints: prev.constraints.map((c) => (c.id === id ? { ...c, text } : c)),
    }))
  }

  const saveGoal = async () => {
    const sessionID = params.id
    if (!sessionID) return
    const c = client()
    const objective = draft().objective.trim()
    if (!objective) {
      showToast({ title: language.t("goal.toast.objectiveRequired") })
      return
    }
    setSaving(true)
    try {
      const current = goal()
      const result = await c.serverGoal.update({
        sessionID,
        objective,
        acceptanceCriteria: draft().acceptanceCriteria.filter((entry) => entry.text.trim().length > 0),
        constraints: draft().constraints.filter((entry) => entry.text.trim().length > 0),
        sourceMessageIDs: current?.sourceMessageIDs ?? [],
        expectedVersion: current?.version,
      })
      setGoal(result)
      setEditing(false)
      showToast({ variant: "success", icon: "circle-check", title: language.t("goal.toast.saved") })
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
      // A 409 means someone else's write landed first -- reload so the next attempt is not
      // built on a version that is already stale.
      void load()
    } finally {
      setSaving(false)
    }
  }

  const setGoalStatus = async (status: GoalStatus) => {
    const sessionID = params.id
    const current = goal()
    if (!sessionID || !current) return
    const c = client()
    try {
      const result = await c.serverGoal.status({ sessionID, status, expectedVersion: current.version })
      setGoal(result)
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
      void load()
    }
  }

  const startSupersede = (entry: LedgerEntry) => {
    setSupersedingID(entry.id)
    setSupersedeText(entry.text)
  }

  const cancelSupersede = () => setSupersedingID(undefined)

  const confirmSupersede = async (entry: LedgerEntry) => {
    const sessionID = params.id
    const text = supersedeText().trim()
    if (!sessionID || !text) return
    const c = client()
    try {
      const added = await c.serverLedger.add({ sessionID, kind: entry.kind, text, sourceMessageIDs: [] })
      await c.serverLedger.supersede({ sessionID, entryID: entry.id, supersededBy: added.id })
      setSupersedingID(undefined)
      await load()
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  const restoreScroll = () => {
    const el = scroll
    if (!el) return
    const s = view().scroll("goal")
    if (!s) return
    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }
  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    view().setScroll("goal", { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })
  }

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        <Show
          when={!loading()}
          fallback={<div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>}
        >
          <div class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <div class="text-12-regular text-text-weak">{language.t("goal.objective.title")}</div>
              <Show when={goal() && !editing()}>
                <div class="flex items-center gap-2">
                  <StatusBadge status={goal()!.status} />
                  <Button size="small" variant="ghost" onClick={startEditing}>
                    <Icon name="edit" size="small" />
                    <span>{language.t("common.edit")}</span>
                  </Button>
                </div>
              </Show>
            </div>

            <Show
              when={editing()}
              fallback={
                <Show
                  when={goal()}
                  fallback={
                    <div class="flex flex-col gap-2">
                      <div class="text-12-regular text-text-weak">{language.t("goal.empty")}</div>
                      <Button size="small" variant="secondary" class="self-start" onClick={startEditing}>
                        {language.t("goal.setGoal")}
                      </Button>
                    </div>
                  }
                >
                  {(g) => (
                    <div class="flex flex-col gap-6">
                      <div class="border border-border-base rounded-md bg-surface-base px-3 py-2 text-12-regular">
                        {g().objective}
                      </div>

                      <div class="flex flex-col gap-2">
                        <div class="text-12-regular text-text-weak">{language.t("goal.acceptanceCriteria.title")}</div>
                        <Show
                          when={g().acceptanceCriteria.length > 0}
                          fallback={<div class="text-12-regular text-text-weaker">{language.t("goal.acceptanceCriteria.empty")}</div>}
                        >
                          <ul class="flex flex-col gap-1.5">
                            <For each={g().acceptanceCriteria}>
                              {(criterion) => (
                                <li class="flex items-center gap-2">
                                  <StatusBadge status={criterion.status} />
                                  <span class="text-12-regular text-text-strong">{criterion.text}</span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>

                      <div class="flex flex-col gap-2">
                        <div class="text-12-regular text-text-weak">{language.t("goal.constraints.title")}</div>
                        <Show
                          when={g().constraints.length > 0}
                          fallback={<div class="text-12-regular text-text-weaker">{language.t("goal.constraints.empty")}</div>}
                        >
                          <ul class="flex flex-col gap-1.5">
                            <For each={g().constraints}>
                              {(constraint) => (
                                <li class="flex items-center gap-2">
                                  <span class="text-12-regular text-text-strong">{constraint.text}</span>
                                  <Show when={constraint.sourceMessageID}>
                                    <Tag>{language.t("goal.constraints.fromMessage")}</Tag>
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </div>

                      <div class="flex flex-col gap-2">
                        <div class="text-12-regular text-text-weak">{language.t("goal.status.title")}</div>
                        <div class="flex items-center gap-2">
                          <For each={["active", "achieved", "abandoned"] as const}>
                            {(status) => (
                              <Button
                                size="small"
                                variant={g().status === status ? "primary" : "ghost"}
                                disabled={g().status === status}
                                onClick={() => setGoalStatus(status)}
                              >
                                {status}
                              </Button>
                            )}
                          </For>
                        </div>
                      </div>
                    </div>
                  )}
                </Show>
              }
            >
              <div class="flex flex-col gap-6">
                <TextField
                  label={language.t("goal.objective.title")}
                  hideLabel
                  multiline
                  value={draft().objective}
                  onChange={(value: string) => setDraft((prev) => ({ ...prev, objective: value }))}
                  placeholder={language.t("goal.objective.placeholder")}
                />

                <div class="flex flex-col gap-2">
                  <div class="flex items-center justify-between">
                    <div class="text-12-regular text-text-weak">{language.t("goal.acceptanceCriteria.title")}</div>
                    <Button size="small" variant="ghost" onClick={addCriterion}>
                      <Icon name="plus-small" size="small" />
                      <span>{language.t("common.add")}</span>
                    </Button>
                  </div>
                  <ul class="flex flex-col gap-1.5">
                    <For each={draft().acceptanceCriteria}>
                      {(criterion) => (
                        <li class="flex items-center gap-2">
                          <TextField
                            label={language.t("goal.acceptanceCriteria.title")}
                            hideLabel
                            class="flex-1"
                            value={criterion.text}
                            onChange={(value: string) => setCriterionText(criterion.id, value)}
                          />
                          <Button
                            size="small"
                            variant={criterion.status === "met" ? "primary" : "ghost"}
                            onClick={() => setCriterionStatus(criterion.id, criterion.status === "met" ? "open" : "met")}
                          >
                            {language.t("goal.acceptanceCriteria.met")}
                          </Button>
                          <Button
                            size="small"
                            variant={criterion.status === "waived" ? "primary" : "ghost"}
                            onClick={() => setCriterionStatus(criterion.id, criterion.status === "waived" ? "open" : "waived")}
                          >
                            {language.t("goal.acceptanceCriteria.waive")}
                          </Button>
                          <Button size="small" variant="ghost" onClick={() => removeCriterion(criterion.id)}>
                            <Icon name="close-small" size="small" />
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>

                <div class="flex flex-col gap-2">
                  <div class="flex items-center justify-between">
                    <div class="text-12-regular text-text-weak">{language.t("goal.constraints.title")}</div>
                    <Button size="small" variant="ghost" onClick={addConstraint}>
                      <Icon name="plus-small" size="small" />
                      <span>{language.t("common.add")}</span>
                    </Button>
                  </div>
                  <ul class="flex flex-col gap-1.5">
                    <For each={draft().constraints}>
                      {(constraint) => (
                        <li class="flex items-center gap-2">
                          <TextField
                            label={language.t("goal.constraints.title")}
                            hideLabel
                            class="flex-1"
                            value={constraint.text}
                            onChange={(value: string) => setConstraintText(constraint.id, value)}
                          />
                          <Button size="small" variant="ghost" onClick={() => removeConstraint(constraint.id)}>
                            <Icon name="close-small" size="small" />
                          </Button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>

                <div class="flex items-center gap-2">
                  <Button size="small" variant="primary" disabled={saving()} onClick={saveGoal}>
                    {language.t("common.save")}
                  </Button>
                  <Button size="small" variant="ghost" disabled={saving()} onClick={cancelEditing}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
              </div>
            </Show>
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("goal.ledger.title")}</div>
            <Show
              when={ledger().length > 0}
              fallback={<div class="text-12-regular text-text-weaker">{language.t("goal.ledger.empty")}</div>}
            >
              <ul class="flex flex-col gap-2">
                <For each={ledger()}>
                  {(entry) => (
                    <li class="border border-border-base rounded-md bg-surface-base px-3 py-2 flex flex-col gap-2">
                      <div class="flex items-center justify-between gap-2">
                        <Tag>{entry.kind}</Tag>
                        <Show when={supersedingID() !== entry.id}>
                          <Button size="small" variant="ghost" onClick={() => startSupersede(entry)}>
                            {language.t("goal.ledger.supersede")}
                          </Button>
                        </Show>
                      </div>
                      <Show
                        when={supersedingID() === entry.id}
                        fallback={<div class="text-12-regular text-text-strong">{entry.text}</div>}
                      >
                        <div class="flex flex-col gap-2">
                          <TextField
                            label={language.t("goal.ledger.supersede")}
                            hideLabel
                            multiline
                            value={supersedeText()}
                            onChange={setSupersedeText}
                          />
                          <div class="flex items-center gap-2">
                            <Button size="small" variant="primary" onClick={() => confirmSupersede(entry)}>
                              {language.t("common.save")}
                            </Button>
                            <Button size="small" variant="ghost" onClick={cancelSupersede}>
                              {language.t("common.cancel")}
                            </Button>
                          </div>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
      </div>
    </ScrollView>
  )
}
