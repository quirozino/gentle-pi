# External task event (`gentle-pi:external-task/v1`)

A pi extension tool that is not a Gentle subagent can show its run in the Agents card above the editor and in the `gentle:agents` overlay (alt+a): it appears in the task list, and its steps stream into the overlay's thread pane, which follows the newest step when follow mode (`f`) is on.

The tasks are display-only. Gentle Agents never launches, cancels, persists, or messages them; the model's `subagent_list_tasks` can list them, but no tool can cancel or reply to them. They live for the current pi process only.

## Emitting

Emit on `pi.events`. With no Gentle Agents listener, the emit is a no-op, so the tool keeps working without gentle-pi.

```ts
const CHANNEL = "gentle-pi:external-task/v1";
const base = { version: 1, source: "my-extension", id: toolCallId, sessionId: ctx.sessionManager.getSessionId() };

pi.events.emit(CHANNEL, { ...base, phase: "start", agent: "my tool", label: "what this run does" });
pi.events.emit(CHANNEL, { ...base, phase: "step", text: "launching browser" });
pi.events.emit(CHANNEL, { ...base, phase: "end", status: "completed", result: "short summary" });
// or: { ...base, phase: "end", status: "failed", error: "short reason" }
```

| Field | Rule |
| --- | --- |
| `version` | `1`. Any other value is ignored. |
| `source` | Lowercase `[a-z0-9-]`, 1 to 64 characters. Namespaces the id. |
| `id` | `[A-Za-z0-9_.:-]`, 1 to 128 characters. Unique per run, for example the tool call id. |
| `sessionId` | Must equal the current session id. Events for any other session are ignored. |
| `phase` | `start`, `step`, or `end`. A step or end without a prior start is ignored, as is any event after `end`. |
| `agent`, `label` | Optional on `start`. Bounded to 64 and 200 characters. |
| `text` | Required on `step`. Bounded to 400 characters. |
| `status` | Required on `end`: `completed`, `failed`, or `cancelled`. |
| `result`, `error` | Optional on `end`. Bounded to 4000 and 400 characters. |

Terminal control sequences are stripped from every string. Never put secrets in the payload: every pi extension in the process can read `pi.events`.

## Maintenance

The listener is `lib/external-tasks.ts`, installed by `extensions/gentle-agents.ts`. `tests/external-tasks.test.ts` pins the channel name, the payload rules, and the wiring, so an upstream merge that drops the wiring fails the suite. A breaking payload change ships as `/v2` next to `/v1`.
