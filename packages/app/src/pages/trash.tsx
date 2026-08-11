import { createTrashController } from "./trash/trash-controller"
import { TrashView } from "./trash/trash-view"

export function Trash() {
  const controller = createTrashController()
  return <TrashView controller={controller} />
}
