import { createArchivedController } from "./archived/archived-controller"
import { ArchivedView } from "./archived/archived-view"

export function Archived() {
  const controller = createArchivedController()
  return <ArchivedView controller={controller} />
}
