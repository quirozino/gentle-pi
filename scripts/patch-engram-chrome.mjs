#!/usr/bin/env node
/**
 * patch-engram-chrome.mjs
 *
 * Idempotent patch that adds double-line framing and pink color to Engram
 * tool call/result rendering in gentle-engram's memory-tool-chrome.js.
 *
 * This survives npm updates because:
 * 1. gentle-pi is a local package (user-controlled, not overwritten by Pi updates)
 * 2. This script runs as part of gentle-pi's postinstall hook
 * 3. It detects its own marker comment to avoid double-patching
 *
 * The patch modifies gentle-engram's memory-tool-chrome.js which IS in
 * node_modules, but gets re-applied automatically after every install.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Marker comment to detect if patch was already applied
const PATCH_MARKER = "/* ENGRAM_CHROME_PATCHED_V1 */";

// Find gentle-engram's directory
function findEngramDir() {
  const candidates = [
    join(__dirname, "..", "..", "npm", "node_modules", "gentle-engram"),
    join(process.env.HOME ?? "~", ".pi", "agent", "npm", "node_modules", "gentle-engram"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "memory-tool-chrome.js"))) return candidate;
  }
  return null;
}

// The patched renderCallText function
const PATCHED_RENDER_CALL = `${PATCH_MARKER}
export function renderCallText(toolName, args = {}) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  // Pink ANSI: 256-color 205 (hot pink) + bold
  const pink = (s) => \`\\x1b[38;5;205m\\x1b[1m\${s}\\x1b[0m\`;
  return pink(\`╔ \${inner} ╗\`);
}`;

// The patched renderResultText function
const PATCHED_RENDER_RESULT = `export function renderResultText(toolName, result, options = {}) {
  const status = compactResultStatus(toolName, result, options);
  const pink = (s) => \`\\x1b[38;5;205m\${s}\\x1b[0m\`;
  if (!options.expanded || options.isPartial) return pink(\`╠ \${status} ╣\`);

  const text = firstTextContent(result);
  if (text) return pink(\`╠ \${status} ╣\`) + \`\\n\\n\${text}\`;

  const data = resultData(result);
  return pink(\`╠ \${status} ╣\`) + \`\\n\\n\${truncateText(JSON.stringify(data, null, 2), 2000)}\`;
}`;

function patchChrome(engramDir) {
  const target = join(engramDir, "memory-tool-chrome.js");
  const original = readFileSync(target, "utf8");

  if (original.includes(PATCH_MARKER)) {
    console.log("patch-engram-chrome: chrome already patched; skipping.");
    return true;
  }

  let patched = original.replace(
    /export function renderCallText\(toolName, args = \{\}\) \{[\s\S]*?^}/m,
    PATCHED_RENDER_CALL,
  );
  patched = patched.replace(
    /export function renderResultText\(toolName, result, options = \{\}\) \{[\s\S]*?^}/m,
    PATCHED_RENDER_RESULT,
  );

  if (!patched.includes(PATCH_MARKER)) {
    console.error("patch-engram-chrome: failed to apply chrome patch.");
    return false;
  }

  writeFileSync(target, patched, "utf8");
  console.log(`patch-engram-chrome: patched ${target}`);
  return true;
}

function patchTests(engramDir) {
  const testFile = join(engramDir, "test", "memory-tool-chrome.test.mjs");
  if (!existsSync(testFile)) return;
  const content = readFileSync(testFile, "utf8");
  if (content.includes("PATCHED_V1")) {
    console.log("patch-engram-chrome: tests already patched; skipping.");
    return;
  }
  const patchedTest = join(__dirname, "..", "tests", "engram-chrome-patched-test.mjs");
  if (!existsSync(patchedTest)) {
    console.warn("patch-engram-chrome: patched test template not found; skipping test patch.");
    return;
  }
  writeFileSync(testFile, readFileSync(patchedTest, "utf8"), "utf8");
  console.log(`patch-engram-chrome: patched ${testFile}`);
}

export function patchEngramChrome() {
  const engramDir = findEngramDir();
  if (!engramDir) {
    console.warn("patch-engram-chrome: gentle-engram not found; skipping.");
    return false;
  }
  const chromeOk = patchChrome(engramDir);
  patchTests(engramDir);
  return chromeOk;
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  patchEngramChrome();
}
