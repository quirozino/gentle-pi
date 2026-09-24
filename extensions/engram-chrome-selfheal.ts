// Self-heals gentle-engram's memory-tool chrome patch (the pink, full-width,
// double-line box around mem_* tool calls) at gentle-pi's OWN extension-load
// time, not only at `npm install`.
//
// Why this exists: the chrome is produced by patching TWO files inside
// gentle-engram's own node_modules install (memory-tool-chrome.js and
// index.ts -- see scripts/patch-engram-chrome.mjs for the full rationale and
// the marker-guarded, idempotent patch itself). gentle-engram can update
// itself independently of gentle-pi (its own auto-update, or a bare
// `npm update gentle-engram`), and that never runs gentle-pi's postinstall
// hook -- so a fresh gentle-engram install silently reverts to pristine,
// unpatched renderCall/renderResult, and the pink box disappears with zero
// trace. Re-running the same idempotent patch here means every gentle-pi
// extension load re-heals it if needed, instead of only a fresh install.
//
// Why not reach the LIVE tool-definition object instead of patching files on
// disk (no re-patch needed, ever, and no import-order caveat below)? This was
// investigated and is not reachable from inside a gentle-pi extension:
//   - `ExtensionContext`/`ExtensionAPI` (what a `session_start` handler and
//     `pi` actually expose -- see @earendil-works/pi-coding-agent's
//     dist/core/extensions/types.d.ts) expose no accessor that reaches the
//     `AgentSession` instance (which owns `getToolDefinition`/
//     `_toolDefinitions`, agent-session.js) or the `ExtensionRunner` instance
//     (which independently owns the same live object per extension via
//     `ext.tools`, runner.js `getToolDefinition`/`getAllRegisteredTools`).
//   - `ctx.sessionManager` -- the one field this codebase already narrow-casts
//     past its public type elsewhere (see gentle-agents.ts's
//     `ReviewSessionManager` cast) -- is `AgentSession.sessionManager`, a
//     *different*, purely persistence-layer object (session file/entries);
//     it has no path back to the tool registry.
//   - `pi.getAllTools()` / `ctx` event payloads (e.g. `ToolExecutionStartEvent`)
//     only ever return freshly-built plain projections (name/description/
//     parameters/...) or bare toolName/args strings, never the live
//     definition object gentle-engram passed to `registerTool`.
//   - `dist/core/extensions/runner.js`'s `createContext()` builds every
//     `ctx.*` accessor as a closure over a local `const runner = this`; JS
//     closures are not introspectable from outside, so there is no property
//     chain from the returned `ctx` object back to that `runner` (or from
//     there to `this.extensions`, which is where the live per-extension
//     `tools` Map -- and the live registered tool object -- actually lives).
// So file-patching, not live-object mutation, is the only reachable lever.
//
// Caveat this carries (unavoidable for a file patch applied from inside the
// same process that also needs it): gentle-pi's extensions load sequentially
// -- each extension module is imported AND its default export invoked before
// the next one starts (see loadExtensionsInternal in
// @earendil-works/pi-coding-agent's extension loader) -- and gentle-engram's
// own extension binds its renderCall/renderResult closures to
// memory-tool-chrome.js's exports at THAT import. If gentle-engram's
// extension happens to import before this one in a given process (gentle-pi
// does not control cross-package extension load order), the patch below
// still runs and fixes the files on disk, but this session still renders
// unpatched chrome -- Node has already cached the unpatched module in
// memory. The very next Pi start (a fresh process, a fresh module cache)
// picks up the now-patched files from its first import, so the cost is at
// most one stale session per gentle-engram update, never a permanently dead
// patch the way postinstall-only was.
import { patchEngramChrome } from "../scripts/patch-engram-chrome.mjs";

// Runs at MODULE IMPORT time (top level, not inside the default export
// below): that is the earliest point in this extension's load, and the
// caveat above only shrinks the closer this runs to the start of the
// process. Wrapped defensively: a future Pi or gentle-engram release could
// move the internals patchEngramChrome depends on (see that module's own
// findEngramDir/marker/anchor comments), and a cosmetic chrome patch must
// never be the reason a session fails to start.
try {
	patchEngramChrome({ quiet: true });
} catch {
	// No-op: gentle-engram tools still work without the chrome patch, they
	// just render as plain, unstyled text.
}

// This extension has no behavior beyond the module-load side effect above --
// it registers no tools, commands, or event handlers. Every gentle-pi
// extension file must still export a callable factory (the loader treats a
// non-function default export as a load failure), so this one is a no-op.
export default function engramChromeSelfHeal(): void {}
