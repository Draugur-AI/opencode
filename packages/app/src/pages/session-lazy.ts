import { lazy } from "solid-js"

export const TargetSessionRoute = lazy(() => import("./target-session-route"))
export const preloadSessionRoute = TargetSessionRoute.preload

const loadSession = () => import("./session")
export const SessionPage = lazy(() => loadSession().then((module) => ({ default: module.SessionPage })))
export const SessionRouteErrorBoundary = lazy(() =>
  loadSession().then((module) => ({ default: module.SessionRouteErrorBoundary })),
)
