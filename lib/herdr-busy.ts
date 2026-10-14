/**
 * Pane activity for herdr while the parent waits for input but background
 * work (subagents, bash_background jobs) is still running. Payload:
 * `{ active: boolean }`, edge-triggered and balanced: one `true` when the first
 * unit starts, one `false` when the last one ends or the session shuts down.
 * herdr's pi reporter maps an active signal to `working`, below `blocked`.
 */
export const HERDR_BUSY_EVENT = "herdr:busy";
