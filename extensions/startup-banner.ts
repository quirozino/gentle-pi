import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAnimationPolicy } from "../lib/animation-policy.ts";
import { activeThemeName, paintWordmarkLine, resolveWordmark, type WordmarkMap } from "../lib/theme-wordmark.ts";
import {
  bannerSuppressed,
  headerOwnershipVerdict,
  pickIntroMode,
  type HeaderOwnership,
  type HeaderOwnershipVerdict,
  type IntroMode,
} from "../lib/banner-visibility.ts";

const PI_AGENT_DIR = join(os.homedir(), ".pi", "agent");
const PI_NPM_DIR = join(PI_AGENT_DIR, "npm", "node_modules");

type BannerColor = "pink" | "cyan" | "yellow" | "green";
interface BannerConfig {
  showRose: boolean;
  showTextLogo: boolean;
  color: BannerColor;
  // Optional theme -> wordmark map read by resolveWordmark(); unvalidated here
  // on purpose so a malformed or future-shaped entry still round-trips through
  // /gentle:banner instead of being silently dropped on the next write.
  wordmarks?: WordmarkMap;
}
const DEFAULT_BANNER_CONFIG: BannerConfig = {
  showRose: true,
  showTextLogo: true,
  color: "pink",
};
const BANNER_COLORS: BannerColor[] = ["pink", "cyan", "yellow", "green"];
const BANNER_PALETTES: Record<BannerColor, { rose: [number, number, number]; label: [number, number, number]; value: [number, number, number]; logoFresh: [number, number, number]; logoDim: [number, number, number] }> = {
  pink: { rose: [255, 118, 195], label: [200, 100, 160], value: [255, 140, 210], logoFresh: [255, 138, 206], logoDim: [95, 30, 60] },
  cyan: { rose: [95, 210, 255], label: [85, 170, 205], value: [130, 225, 255], logoFresh: [105, 220, 255], logoDim: [25, 80, 100] },
  yellow: { rose: [255, 210, 95], label: [210, 165, 65], value: [255, 225, 135], logoFresh: [255, 215, 105], logoDim: [105, 75, 25] },
  green: { rose: [110, 220, 145], label: [85, 175, 115], value: [145, 240, 170], logoFresh: [120, 230, 150], logoDim: [30, 95, 50] },
};

const TEXT_LOGO = [
  "                  ▄▄▄▀▀▀▀▀██                                ▄▄▀▄▄          ▄▄█▀▀▀██   ▄▄▀██               ▄▄▀▄▄   ▄▄▀▄▄",
  "              ▄▄█▀▀▒▒▒▒▒▄▄█▀▒                   ▄██     ▄▄█▀█▄█▀▒▒       ▄█▀▀▒▒▒▄█▀▒ ▄██▄█▀▒           ▄▄█▀█▄█▀▄▄█▀█▄█▀▒",
  "          ▄▄██▀▒▒▒▒▒▄▄▄▀▀▒▒▒▒        ▄▄▄  ▀▀▀▀██▀▀▀▀▀███▀█▄▀▀▒▒▒▒      ██▄▄▒▒▒▒▒▒▒ ▄██▀▀▒▒▒          ▄██▀█▄▀▀▄██▀█▄▀▀▒▒▒",
  "        ▄██▀▒▒▒▒     ▒▒▄▄█ ▄▄▄▀██ ▄▄▄▀▀▀▄  ▄██▀▒▒▒▒▄██▀▀▀▒▄▄███         ▀▀▀██▄▄  ▄██▀▒▄▄▀██   ▄▄▀▀██ ██▀▀▀▒▒▒██▀▀▀▒▒▒",
  "       ██▀▒▒▒     ▄▄▄███▀▄██▀▀▀▄▄██▀▀▄█▀▄▄██▀▒▒▒▄▄██▀▒▒▄██▀▀▀▄▄      ▄▄     ▀██▄▄██▀▄██▀██▒  ▄██▄▄▀▒ █▀▒▒▒   █▀▒▒▒",
  "       ▀█▄▄▄▄▄▀▀▀█▄▄███▄▒▀▀▀▀▀▀▒▀▀▒▒▀▀▀▀▒██▄▄▀▀▀ ▀█▄▀▀▀ ▀▀▀▀▀▒▒      ▀█▄▄▄▄█▀▀▒▒▀▀▒▒▀▀▒ ██▄▄▀▀█▄▄▄▄▀▀█▄▄▀▀▀▄▄▀█▄▄▀▀▀",
  "        ▒▄▄▄█▀▀▀█▄█▀▀▒▒▒▒ ▒▒▒▒▒▒ ▒▒  ▒▒▒▒ ▒▒▒▒▒▒▒ ▒▒▒▒▒▒ ▒▒▒▒▒        ▒▀▀▀▀▒▒▒▒  ▒▒▒▒▒▒ ▒▒▒▒▒ ▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒",
  "     ▄▄▀▀ ▒▒▒▒▄██▀▒▒▒▒",
  "   ▄█ ▒▒▒▄▄██▀▀▒▒▒▒",
  "    ▀▀▀▀▀▀▒▒▒▒▒▒",
  "     ▒▒▒▒▒▒",
];

const ROSE_LARGE_RAW = [
  "             ⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀  ⢀⣀⣀",
  "          ⢀⣴⣿⣿⠿⣋⣭⣭⣯⣭⣍⣭⣿⣟⠛⠛⠿⣿⣷⣄",
  "      ⢀⣴⣾⡟⢻⣿⡟⠁⣼⣿⠏⣵⢻⣿⣻⣿⣿⢿⡻⣿⣿⣶⡌⢿⣿⣷⣦⣤⡄",
  "   ⣤⣶⣾⣿⣿⠏ ⠈⢿⣄ ⢹⣏⠠⠟⣾⣿⣿⣿⣿⣿⠷⣏⣼⠟⢡⣿⡟⠋⢻⣿⣿⡄",
  "   ⠈⣿⣿⣿⣿⡆   ⣽⢧⡘⠈⠳⣦⣍⠛⠛⢦⣉⣴⣛⣫⣭⣴⡟⠋  ⣾⣿⣿⡿",
  "   ⢀⠹⣿⣿⣿⣷⣤⡄ ⠋ ⠙⢆ ⣠⠴⠟⠛⣛⣛⣛⠟⠋⠁⠺⡇ ⣀⣴⣿⣿⡟⠁",
  "   ⠈⣀⠈⠛⠷⠿⣿⣿⣷⣤⣀ ⢠⠋   ⠈⠉⠉    ⣠⣴⣥⠾⠛⠉⣰⣿⣷",
  "          ⠹⣯⣝⠛⠛⠷⢶⣤⣤⣀   ⢀⡠⠖⠋⠉⢉⣀⣀⣴⣾⣿⠿⠟⠃",
  "             ⠘⠻⢿⣦⣄⡀  ⠉⠛⢦⠠⢊⠤⠴⢒⣛⣛⣩⣽⡿⠟⠁",
  "        ⠶⢶⣤⣄⡀⠨⠭⠽⠟⣓⢦⣀⠈⢇⡥⠖⠛⠋⠉⠉",
  "           ⠈⢷ ⠐⠂⢤⣽⣄ ⠰⡎⠙⠳⣄⡀ ⠈⢣⠘⢦⠋",
  "            ⠈⢳⣀⡒⠉⠉⣉⠙⡲⣽⣄ ⣏⠳⡄ ⠘⡇ ⡾⠁",
  "              ⠛⠻⢦⣄⣉⡁⣀⣀⣈⣙⣺⣌⡇⢠⢀⡇⡾",
  "                   ⠈⠉    ⠈⠳⡄⣸⢱⠇",
  "                           ⡷⠡⡯⢖⠉",
  "                        ⢀⡴⢪⠔⣉⠔⠋",
  "                           ⠐⠈",
];

function rgb(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function gentleAiConfigHome(): string {
  return process.env.GENTLE_PI_CONFIG_HOME ?? join(os.homedir(), ".pi", "gentle-ai");
}

function bannerConfigPath(): string {
  return join(gentleAiConfigHome(), "banner.json");
}

function normalizeBannerConfig(value: unknown): BannerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_BANNER_CONFIG };
  const record = value as Record<string, unknown>;
  // wordmarks is passed through as-is (shape-checked, not deep-validated): the
  // per-theme entries are validated on demand by resolveWordmark() at render
  // time, so an entry another gentle-pi version understands keeps round-tripping
  // through /gentle:banner even while this build cannot render it.
  const wordmarks =
    typeof record.wordmarks === "object" && record.wordmarks !== null && !Array.isArray(record.wordmarks)
      ? (record.wordmarks as WordmarkMap)
      : undefined;
  return {
    showRose: typeof record.showRose === "boolean" ? record.showRose : DEFAULT_BANNER_CONFIG.showRose,
    showTextLogo: typeof record.showTextLogo === "boolean" ? record.showTextLogo : DEFAULT_BANNER_CONFIG.showTextLogo,
    color: BANNER_COLORS.includes(record.color as BannerColor) ? record.color as BannerColor : DEFAULT_BANNER_CONFIG.color,
    ...(wordmarks !== undefined ? { wordmarks } : {}),
  };
}

async function readBannerConfig(): Promise<BannerConfig> {
  try {
    return normalizeBannerConfig(JSON.parse(await readFile(bannerConfigPath(), "utf8")));
  } catch {
    return { ...DEFAULT_BANNER_CONFIG };
  }
}

async function writeBannerConfig(config: BannerConfig): Promise<void> {
  const path = bannerConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function paletteColor(color: BannerColor, key: keyof typeof BANNER_PALETTES[BannerColor], text: string): string {
  const [r, g, b] = BANNER_PALETTES[color][key];
  return rgb(r, g, b, text);
}

function normalizeAscii(lines: string[]): string[] {
  const trimmed = lines.map((l) => l.replace(/\s+$/g, ""));
  const nonEmpty = trimmed.filter((l) => l.trim().length > 0);
  const minLead = nonEmpty.length
    ? Math.min(...nonEmpty.map((l) => (l.match(/^\s*/) || [""])[0].length))
    : 0;
  return trimmed.map((l) => (l.length >= minLead ? l.slice(minLead) : l));
}

function padLines(lines: string[]): { lines: string[]; width: number } {
  const width = Math.max(...lines.map((l) => l.length), 0);
  return { lines: lines.map((l) => l.padEnd(width)), width };
}

type CellType =
  | "banner"
  | "logo-tip"
  | "logo-fresh"
  | "logo-ink"
  | "rose"
  | "label"
  | "value"
  | "dim"
  | "accent"
  | "none"
  // Holds an already fully rendered (pre-coloured) string as its single
  // cell -- see LayoutBuilder.addRaw(). Used by the theme wordmark, whose
  // colouring comes from paintWordmarkLine()/theme.fg() rather than from
  // the per-cell switch below.
  | "raw";
type LayoutCell = { char: string; type: CellType };
type LogoCellType = Extract<
  CellType,
  "banner" | "logo-tip" | "logo-fresh" | "logo-ink"
>;

const LOGO_CELL_TYPES: ReadonlySet<CellType> = new Set<CellType>([
  "banner",
  "logo-tip",
  "logo-fresh",
  "logo-ink",
]);

function isLogoCellType(type: CellType): type is LogoCellType {
  return LOGO_CELL_TYPES.has(type);
}

type Span = { start: number; end: number };

function computeLogoBounds(lines: string[]): Span {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== " ") {
        if (i < start) start = i;
        if (i > end) end = i;
      }
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { start: 0, end: 0 };
  }
  return { start, end };
}

function buildLetterSpans(bounds: Span, weights: number[]): Span[] {
  const spanWidth = Math.max(1, bounds.end - bounds.start + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = bounds.start;
  return weights.map((w, i) => {
    const remaining = bounds.end - cursor + 1;
    const raw = Math.max(1, Math.round((w / total) * spanWidth));
    const width =
      i === weights.length - 1
        ? remaining
        : Math.min(raw, remaining - (weights.length - i - 1));
    const s = cursor;
    const e = s + width - 1;
    cursor = e + 1;
    return { start: s, end: e };
  });
}

const LOGO_BOUNDS = computeLogoBounds(TEXT_LOGO);
// Variable-width script regions, including the gap before Shell and shadows.
const LETTER_WEIGHTS = [22, 9, 8, 9, 8, 9, 10, 13, 8, 8, 13]; // G E N T L E S H E L L
const LETTER_SPANS = buildLetterSpans(LOGO_BOUNDS, LETTER_WEIGHTS);

function letterIndexAtX(x: number): number {
  for (let i = 0; i < LETTER_SPANS.length; i++) {
    const s = LETTER_SPANS[i];
    if (x >= s.start && x <= s.end) return i;
  }
  if (x < LETTER_SPANS[0].start) return 0;
  return LETTER_SPANS.length - 1;
}

type Point = { x: number; y: number };

function pointKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function buildLetterStrokeMap(letterIdx: number): { orderMap: Map<string, number>; maxOrder: number } {
  const span = LETTER_SPANS[letterIdx];
  const points: Point[] = [];
  const pointSet = new Set<string>();

  for (let y = 0; y < TEXT_LOGO.length; y++) {
    const line = TEXT_LOGO[y] ?? "";
    for (let x = span.start; x <= Math.min(span.end, line.length - 1); x++) {
      if (line[x] !== " ") {
        points.push({ x, y });
        pointSet.add(pointKey(x, y));
      }
    }
  }

  const neighbors8 = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;

  const visited = new Set<string>();
  const components: Point[][] = [];

  for (const p of points) {
    const k = pointKey(p.x, p.y);
    if (visited.has(k)) continue;

    const stack = [p];
    const comp: Point[] = [];
    visited.add(k);

    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const [dx, dy] of neighbors8) {
        const nk = pointKey(cur.x + dx, cur.y + dy);
        if (!visited.has(nk) && pointSet.has(nk)) {
          visited.add(nk);
          stack.push({ x: cur.x + dx, y: cur.y + dy });
        }
      }
    }

    components.push(comp);
  }

  components.sort((a, b) => {
    const ax = Math.min(...a.map((p) => p.x));
    const bx = Math.min(...b.map((p) => p.x));
    if (ax !== bx) return ax - bx;
    const ay = Math.min(...a.map((p) => p.y));
    const by = Math.min(...b.map((p) => p.y));
    return ay - by;
  });

  const orderMap = new Map<string, number>();
  let order = 0;

  for (const comp of components) {
    const compSet = new Set(comp.map((p) => pointKey(p.x, p.y)));
    const compMap = new Map(comp.map((p) => [pointKey(p.x, p.y), p]));

    let current = comp.reduce((best, p) =>
      p.x < best.x || (p.x === best.x && p.y < best.y) ? p : best,
    );

    let dirX = 1;
    let dirY = 0;

    while (compSet.size > 0) {
      const ck = pointKey(current.x, current.y);
      if (compSet.has(ck)) {
        compSet.delete(ck);
        orderMap.set(ck, order++);
      }
      if (compSet.size === 0) break;

      const candidates: Point[] = [];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nk = pointKey(current.x + dx, current.y + dy);
          if (compSet.has(nk)) {
            const point = compMap.get(nk);
            if (point) candidates.push(point);
          }
        }
      }

      let next: Point | null = null;
      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          const adx = a.x - current.x;
          const ady = a.y - current.y;
          const bdx = b.x - current.x;
          const bdy = b.y - current.y;

          const aDist = Math.hypot(adx, ady);
          const bDist = Math.hypot(bdx, bdy);
          const aTurn = Math.abs(adx * dirY - ady * dirX);
          const bTurn = Math.abs(bdx * dirY - bdy * dirX);

          const aScore = aDist * 3.8 + aTurn * 1.3 + Math.abs(ady) * 0.12;
          const bScore = bDist * 3.8 + bTurn * 1.3 + Math.abs(bdy) * 0.12;
          return aScore - bScore;
        });
        next = candidates[0];
      } else {
        let best: Point | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const k of compSet) {
          const p = compMap.get(k);
          if (!p) continue;
          const dx = p.x - current.x;
          const dy = p.y - current.y;
          const score = Math.hypot(dx, dy) + Math.abs(dy) * 0.16;
          if (score < bestScore) {
            bestScore = score;
            best = p;
          }
        }
        next = best;
      }

      if (!next) break;
      dirX = next.x - current.x;
      dirY = next.y - current.y;
      current = next;
    }
  }

  return { orderMap, maxOrder: Math.max(1, order - 1) };
}

type LetterStroke = { orderMap: Map<string, number>; maxOrder: number };

const WRITING_START_TICK = 6;
const FALLBACK_LETTER_TICKS = 8;

const LETTER_STROKES: Array<LetterStroke | null> = LETTER_SPANS.map(() => null);
const LETTER_TICKS: number[] = LETTER_SPANS.map(() => FALLBACK_LETTER_TICKS);
const LETTER_START_TICKS: number[] = LETTER_SPANS.map(
  (_, i) => WRITING_START_TICK + i * FALLBACK_LETTER_TICKS,
);
let WRITING_END_TICK =
  WRITING_START_TICK + LETTER_TICKS.reduce((a, b) => a + b, 0);

function recomputeLetterTicks(): void {
  for (let i = 0; i < LETTER_STROKES.length; i++) {
    const stroke = LETTER_STROKES[i];
    LETTER_TICKS[i] = stroke
      ? Math.max(5, Math.ceil(((stroke.maxOrder + 8) / 11) * 0.48))
      : FALLBACK_LETTER_TICKS;
  }
  let acc = WRITING_START_TICK;
  for (let i = 0; i < LETTER_TICKS.length; i++) {
    LETTER_START_TICKS[i] = acc;
    acc += LETTER_TICKS[i];
  }
  WRITING_END_TICK = acc;
}

function allStrokesReady(): boolean {
  for (const stroke of LETTER_STROKES) if (stroke === null) return false;
  return true;
}

let warmupStarted = false;
async function warmupLetterStrokes(): Promise<void> {
  if (warmupStarted) return;
  warmupStarted = true;
  for (let i = 0; i < LETTER_SPANS.length; i++) {
    if (LETTER_STROKES[i] !== null) continue;
    LETTER_STROKES[i] = buildLetterStrokeMap(i);
    recomputeLetterTicks();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function buildPenLogoLine(
  line: string,
  rowIdx: number,
  _totalRows: number,
  tick: number,
): LayoutCell[] {
  const out: LayoutCell[] = [];

  for (let x = 0; x < line.length; x++) {
    const ch = line[x] ?? " ";
    if (ch === " ") {
      out.push({ char: " ", type: "none" });
      continue;
    }

    const letterIdx = letterIndexAtX(x);
    const stroke = LETTER_STROKES[letterIdx];
    if (stroke === null) {
      out.push({ char: ch, type: "logo-ink" });
      continue;
    }
    const startTick = LETTER_START_TICKS[letterIdx];
    const duration = LETTER_TICKS[letterIdx];
    const progress = (tick - startTick) / Math.max(1, duration);

    if (progress < 0) {
      out.push({ char: " ", type: "none" });
      continue;
    }

    const head = progress * (stroke.maxOrder + 7);
    const rawOrder = stroke.orderMap.get(pointKey(x, rowIdx));
    if (rawOrder === undefined) {
      out.push({ char: " ", type: "none" });
      continue;
    }

    let order = rawOrder;
    // v1: ajuste SOLO para la primera letra (G), con más curvatura caligráfica.
    if (letterIdx === 0) {
      const s = LETTER_SPANS[0];
      const w = Math.max(1, s.end - s.start + 1);
      const localX = x - s.start;
      const curveBias =
        Math.sin((localX / w) * Math.PI * 1.35 + rowIdx * 0.26) * 2.2 +
        Math.cos((localX / w) * Math.PI * 0.72 - rowIdx * 0.20) * 1.3;
      order = rawOrder + curveBias;
    }

    if (head < order) {
      out.push({ char: " ", type: "none" });
      continue;
    }

    const age = head - order;
    if (age < 1.2) out.push({ char: ch, type: "logo-tip" });
    else if (age < 4.9) out.push({ char: ch, type: "logo-fresh" });
    else out.push({ char: ch, type: "logo-ink" });
  }
  return out;
}

class LayoutBuilder {
  lines: LayoutCell[][] = [];

  addRow() {
    this.lines.push([]);
  }

  add(type: CellType, text: string) {
    const row = this.lines[this.lines.length - 1];
    for (const char of text) row.push({ char, type });
  }

  // Pushes ONE cell whose `char` holds an already fully rendered string (e.g.
  // a wordmark line pre-coloured by paintWordmarkLine, ANSI escapes and all)
  // instead of splitting it into one cell per code point like add() does.
  // Splitting would make center()'s cell-count math (and per-cell colouring
  // below) treat invisible escape bytes as columns, so a pre-rendered line
  // must stay a single opaque cell all the way to the output loop.
  addRaw(text: string) {
    const row = this.lines[this.lines.length - 1];
    row.push({ char: text, type: "raw" });
  }

  // Same padding as center(), but measured against a caller-supplied plain
  // (uncoloured) width instead of the row's cell count -- required for a row
  // built with addRaw(), whose single cell does not carry a visible length.
  centerWithWidth(width: number, plainWidth: number) {
    const row = this.lines[this.lines.length - 1];
    const pad = Math.max(0, Math.floor((width - plainWidth) / 2));
    const prefix: LayoutCell[] = Array.from({ length: pad }, () => ({
      char: " ",
      type: "none" as const,
    }));
    this.lines[this.lines.length - 1] = prefix.concat(row);
  }

  center(width: number) {
    const row = this.lines[this.lines.length - 1];
    const pad = Math.max(0, Math.floor((width - row.length) / 2));
    const prefix: LayoutCell[] = Array.from({ length: pad }, () => ({
      char: " ",
      type: "none" as const,
    }));
    this.lines[this.lines.length - 1] = prefix.concat(row);
  }
}

const RESIZE_DEBOUNCE_MS = 150;
const RESIZE_GRACE_PERIOD_MS = 300;
// Grace window before concluding whether gentle-pi still owns the header
// (last-writer-wins on ctx.ui.setHeader): long enough that a normal boot's
// first render() has already landed, short enough that "taken" is reported
// well before the session is doing real work.
const HEADER_OWNERSHIP_GRACE_MS = 5000;

function currentIntroMode(): IntroMode {
  // process.stdout.rows/columns reflejan el tamaño real del TTY del proceso;
  // el TUI no expone alto en render(width) y por eso lo leemos directo acá.
  const rows = process.stdout.rows ?? 0;
  const cols = process.stdout.columns ?? 0;
  return pickIntroMode(rows, cols);
}

async function countSddAgents(): Promise<number> {
  try {
    const entries = await readdir(join(PI_AGENT_DIR, "agents"), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /^sdd-.*\.md$/.test(entry.name)).length;
  } catch {
    return 0;
  }
}

function packageNameFromSpec(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined;
  const clean = spec.replace(/^npm:/, "");
  if (clean.startsWith("@")) {
    const parts = clean.split("@");
    return parts.length > 2 ? `@${parts[1]}` : clean;
  }
  return clean.split("@")[0] || undefined;
}

async function countPackageExtensions(packages: unknown[]): Promise<number> {
  let count = 0;
  for (const spec of packages) {
    const name = packageNameFromSpec(spec);
    if (!name) continue;
    try {
      const raw = await readFile(join(PI_NPM_DIR, name, "package.json"), "utf8");
      const pkg = JSON.parse(raw);
      const extensions = pkg?.pi?.extensions;
      if (Array.isArray(extensions)) count += extensions.length;
    } catch {
      // Packages installed from non-npm sources may not live in PI_NPM_DIR.
    }
  }
  return count;
}

export function readGitBranch(cwd: string, run: typeof execFile = execFile): Promise<string> {
  return new Promise((resolve) => {
    run("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve("Not a git repo");
        return;
      }
      const branch = String(stdout).trim();
      resolve(branch ? `On branch ${branch}` : "Detached HEAD");
    });
  });
}

function describeHeaderOwnership(verdict: HeaderOwnershipVerdict): string {
  switch (verdict) {
    case "owned":
      return "Header: owned by gentle-pi";
    case "taken":
      return "Header: taken over by another extension";
    case "not-installed":
      return "Header: not installed (intro skipped)";
  }
}

export default function (pi: ExtensionAPI) {
  let disposeHeader = () => {};
  // Header-ownership tracking (Problem B): reset at the start of every
  // session_start so /clone, /resume and /reload re-arm detection instead of
  // carrying a stale verdict or a burned notify budget across sessions.
  let ownership: HeaderOwnership = { installed: false, rendered: false };
  let ownershipReported = false;
  pi.on("session_shutdown", () => disposeHeader());
  const notifyBannerConfig = (ctx: any, config: BannerConfig) => {
    ctx.ui.notify(
      [
        `Startup banner: rose=${config.showRose ? "on" : "off"}, text logo=${config.showTextLogo ? "on" : "off"}, color=${config.color}`,
        describeHeaderOwnership(headerOwnershipVerdict(ownership)),
        `Config: ${bannerConfigPath()}`,
        "Changes apply on the next startup banner render.",
      ].join("\n"),
      "info",
    );
  };

  const registerBannerCommand = (name: string) => {
    pi.registerCommand(name, {
      description: "Configure the Gentle Pi startup banner.",
      handler: async (_args, ctx) => {
        const config = await readBannerConfig();
        const selected = await ctx.ui.select("Startup banner", [
          `Rose: ${config.showRose ? "on" : "off"}`,
          `Text logo: ${config.showTextLogo ? "on" : "off"}`,
          `Color: ${config.color}`,
        ]);
        if (!selected) return;
        if (selected.startsWith("Rose:")) config.showRose = !config.showRose;
        else if (selected.startsWith("Text logo:")) config.showTextLogo = !config.showTextLogo;
        else if (selected.startsWith("Color:")) {
          const color = await ctx.ui.select("Startup banner color", [...BANNER_COLORS]);
          if (!color) return;
          config.color = color as BannerColor;
        }
        await writeBannerConfig(config);
        notifyBannerConfig(ctx, config);
      },
    });
  };
  const registerToggleCommand = (name: string, key: "showRose" | "showTextLogo") => {
    pi.registerCommand(name, {
      description: `Toggle startup banner ${key === "showRose" ? "rose" : "text logo"}.`,
      handler: async (_args, ctx) => {
        const config = await readBannerConfig();
        config[key] = !config[key];
        await writeBannerConfig(config);
        notifyBannerConfig(ctx, config);
      },
    });
  };
  const registerColorCommand = (name: string) => {
    pi.registerCommand(name, {
      description: "Set startup banner color preset.",
      handler: async (args, ctx) => {
        const config = await readBannerConfig();
        const requested = String(args ?? "").trim() as BannerColor;
        if (BANNER_COLORS.includes(requested)) {
          config.color = requested;
        } else {
          const selected = await ctx.ui.select("Startup banner color", [...BANNER_COLORS]);
          if (!selected) return;
          config.color = selected as BannerColor;
        }
        await writeBannerConfig(config);
        notifyBannerConfig(ctx, config);
      },
    });
  };
  registerBannerCommand("gentle:banner");
  registerToggleCommand("gentle:toggle-rose", "showRose");
  registerToggleCommand("gentle:toggle-text-logo", "showTextLogo");
  registerColorCommand("gentle:banner-color");

  pi.on("session_start", async (_event, ctx) => {
    disposeHeader();
    ownership = { installed: false, rendered: false };
    ownershipReported = false;
    if (!ctx.hasUI) return;

    // Si se está ejecutando un comando de CLI como "pi update" o "pi install", no mostramos la intro animada.
    const isCLICommand =
      process.argv.length > 2 &&
      !process.argv.every((arg) => arg.startsWith("-") || arg.endsWith(".ts"));
    if (isCLICommand) return;

    // Pi has already started its renderer. Let setHeader schedule the paint;
    // clearing stdout here would leave its previous-frame cache out of sync.
    const bannerConfig = await readBannerConfig();
    const palette = BANNER_PALETTES[bannerConfig.color];
    const roseBase = padLines(normalizeAscii(ROSE_LARGE_RAW));
    const logoBase = padLines(TEXT_LOGO);
    // Resolved ONCE per session, like roseBase/logoBase above: a theme-keyed
    // wordmark, when present for the active pi theme, takes over the rose and
    // text-logo slot below so there is a single owner of the header instead of
    // two extensions racing setHeader.
    const wordmark = resolveWordmark(bannerConfig, activeThemeName());
    const wordmarkWide = wordmark ? padLines(normalizeAscii(wordmark.art)) : undefined;
    const wordmarkCompact = wordmark?.compact ? padLines(normalizeAscii(wordmark.compact)) : undefined;

    // The intro-size gate asks whether the ANIMATED INTRO is worth playing
    // here, and `skip` is any terminal under 20 rows or 40 columns. A theme
    // wordmark is not an intro: it is the header's identity, and the
    // workstation extension it replaced carried no size gate at all. Gating
    // it here is what made a small -- or not-yet-sized, which a pane inside a
    // multiplexer often is at session_start -- terminal silently fall back to
    // Pi's own default header and lose the wordmark for the whole session,
    // since this return is permanent and the resize handler below never gets
    // installed. So `skip` still suppresses the rose and the text logo, and
    // never a resolved wordmark, which is seven rows and needs no animation
    // to be worth drawing.
    //
    // This calls the SAME bannerSuppressed() predicate as the header
    // render() gate below, ON PURPOSE: the two gates must never be able to
    // disagree again. Fixing only one of them is exactly how the wordmark
    // once vanished -- this early return let a resolved wordmark through,
    // but render() still silently dropped it with its own separate check.
    if (bannerSuppressed(currentIntroMode(), wordmark !== undefined)) return;
    void warmupLetterStrokes();

    let gitBranch = "Not a git repo";
    let mcpServersCount = 0;
    let extensionsCount = 0;
    let packagesCount = 0;
    let sddAgentsCount = 0;

    const allCommands = pi.getCommands();
    const skills = allCommands.filter((c) => c.source === "skill");
    const allTools = pi.getAllTools();
    const customTools = allTools.filter(
      (t) => !["builtin", "sdk"].includes(t.sourceInfo.source),
    );

    setTimeout(() => {
      readGitBranch(ctx.cwd)
        .then((branch) => { gitBranch = branch; })
        .finally(() => refreshStats());
    }, 100);

    setTimeout(() => {
      (async () => {
        try {
          const raw = await readFile(
            join(os.homedir(), ".pi", "agent", "mcp.json"),
            "utf8",
          );
          const cfg = JSON.parse(raw);
          mcpServersCount = Object.keys(cfg.mcpServers || {}).length;
        } catch {
          mcpServersCount = 0;
        }
        refreshStats();
      })();
    }, 150);

    setTimeout(() => {
      (async () => {
        try {
          sddAgentsCount = await countSddAgents();
          const raw = await readFile(
            join(PI_AGENT_DIR, "settings.json"),
            "utf8",
          );
          const cfg = JSON.parse(raw);
          const packages = Array.isArray(cfg.packages) ? cfg.packages : [];
          packagesCount = packages.length;
          extensionsCount = await countPackageExtensions(packages);
        } catch {
          extensionsCount = 0;
          packagesCount = 0;
        }
        refreshStats();
      })();
    }, 200);

    let tick = 0;
    let refreshStats = () => {};
    let headerCache: { key: string; out: string[] } | null = null;
    const state = {
      timer: null as NodeJS.Timeout | null,
      mode: currentIntroMode() as IntroMode,
      resizeHandler: null as (() => void) | null,
      resizeDebounceTimer: null as NodeJS.Timeout | null,
    };

    const cleanup = () => {
      refreshStats = () => {};
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      if (state.resizeHandler) {
        process.stdout.off("resize", state.resizeHandler);
        state.resizeHandler = null;
      }
      if (state.resizeDebounceTimer) {
        clearTimeout(state.resizeDebounceTimer);
        state.resizeDebounceTimer = null;
      }
    };

    disposeHeader = cleanup;
    setTimeout(() => {
      ctx.ui.setHeader((tui, theme) => {
        if (state.timer) clearInterval(state.timer);
        headerCache = null;

        refreshStats = () => tui.requestRender();
        // Capture once: a command changes the live prompt, not this intro.
        const animationPolicy = resolveAnimationPolicy().policy;
        const animStart = Date.now();
        if (animationPolicy === "potato") {
          tick = Number.MAX_SAFE_INTEGER;
          state.timer = null;
        } else {
          const performance = animationPolicy === "performance";
          state.timer = setInterval(() => {
            tick += performance ? 10 : 1;
            const finished = allStrokesReady() && tick > WRITING_END_TICK + 22;
            if (finished || Date.now() - animStart > 5000) {
              clearInterval(state.timer!);
              state.timer = null;
            }
            try { tui.requestRender(); } catch { cleanup(); }
          }, performance ? 250 : 25);
        }

        // Grace period: pi-tui emite resizes transitorios mientras compone su layout inicial.
        const bootStart = Date.now();
        const resizeHandler = () => {
          if (Date.now() - bootStart < RESIZE_GRACE_PERIOD_MS) return;
          if (state.resizeDebounceTimer) clearTimeout(state.resizeDebounceTimer);
          state.resizeDebounceTimer = setTimeout(() => {
            state.resizeDebounceTimer = null;
            const next = currentIntroMode();
            if (next === state.mode) return;
            state.mode = next;
            // Pi owns removal in skip mode; keep listening for later expansion.
            try {
              tui.requestRender();
            } catch {
              cleanup();
            }
          }, RESIZE_DEBOUNCE_MS);
        };
        state.resizeHandler = resizeHandler;
        process.stdout.on("resize", resizeHandler);

        return {
          /** Renders the persistent header grid; memoized per width, tick, mode and stats so static passes reuse the built lines. */
          render(width: number): string[] {
            // Recorded before any early return: a legitimately suppressed
            // (skip mode, no wordmark) call still means gentle-pi's header
            // is the one the TUI is asking to paint, i.e. we still own it.
            ownership.rendered = true;
            // Same reasoning as the session_start gate above: `skip` drops the
            // intro, not the identity. A resolved wordmark keeps painting at
            // any size -- the render below already falls back to the compact
            // form and lets truncateToWidth clip what still does not fit --
            // so a narrow pane shows a smaller wordmark rather than none.
            //
            // This calls the SAME bannerSuppressed() predicate as the
            // session_start gate above, ON PURPOSE -- see the comment there.
            if (bannerSuppressed(state.mode, wordmark !== undefined)) return [];
            const headerKey = `${width}|${tick}|${state.mode}|${gitBranch}|${mcpServersCount}|${extensionsCount}|${packagesCount}|${sddAgentsCount}|${ctx.cwd}|${skills.length}|${customTools.length}`;
            if (headerCache?.key === headerKey) return headerCache.out;

            const flashStartTick = 10;
            const roseOpacity = Math.min(1, tick / 10);
            const flashPhase =
              tick >= flashStartTick
                ? Math.max(0, 1 - (tick - flashStartTick) / 12)
                : 0;
            const frame = Math.floor(tick / 2);

            const sideBySideMinWidth = roseBase.width + 3 + logoBase.width + 4;
            const horizontal =
              state.mode === "full" && bannerConfig.showRose && bannerConfig.showTextLogo && width >= sideBySideMinWidth;
            const wideStatsMinWidth = 122;
            const wideStats = width >= wideStatsMinWidth;

            const b = new LayoutBuilder();
            b.addRow();
            b.center(width);

            if (wordmark && wordmarkWide) {
              // A resolved theme wordmark takes over the rose/text-logo slot
              // entirely, in every mode: it is the ONE owner of this header,
              // not a third layout alongside the other two. Falls back to the
              // compact form only when it exists and the wide art would not
              // fit; with no compact form, the wide art is kept and simply
              // clipped by truncateToWidth() below like any other overflow.
              const useCompact = wordmarkCompact !== undefined && width < wordmarkWide.width + 2;
              const block = useCompact ? wordmarkCompact! : wordmarkWide;
              for (let i = 0; i < block.lines.length; i++) {
                b.addRow();
                b.addRaw(paintWordmarkLine(block.lines, i, tick, theme, wordmark.effect));
                b.centerWithWidth(width, block.width);
              }
            } else if (state.mode === "minimal") {
              if (bannerConfig.showTextLogo) for (let logoI = 0; logoI < logoBase.lines.length; logoI++) {
                const logoLine = logoBase.lines[logoI];
                b.addRow();
                b.lines[b.lines.length - 1].push(
                  ...buildPenLogoLine(logoLine, logoI, logoBase.lines.length, tick),
                );
                b.center(width);
              }
            } else if (horizontal) {
              const rowCount = Math.max(roseBase.lines.length, logoBase.lines.length);
              const roseOffset = Math.max(0, Math.floor((rowCount - roseBase.lines.length) / 2));
              const logoOffset = Math.max(0, Math.floor((rowCount - logoBase.lines.length) / 2));
              for (let i = 0; i < rowCount; i++) {
                const roseI = i - roseOffset;
                const logoI = i - logoOffset;
                const roseLine = roseI >= 0 && roseI < roseBase.lines.length
                  ? roseBase.lines[roseI] : " ".repeat(roseBase.width);
                const logoLine = logoI >= 0 && logoI < logoBase.lines.length
                  ? logoBase.lines[logoI] : " ".repeat(logoBase.width);
                b.addRow();
                b.add("rose", roseLine);
                b.add("none", "   ");
                if (logoI >= 0 && logoI < logoBase.lines.length) {
                  b.lines[b.lines.length - 1].push(
                    ...buildPenLogoLine(logoLine, logoI, logoBase.lines.length, tick),
                  );
                } else {
                  b.add("none", " ".repeat(logoBase.width));
                }
                b.center(width);
              }
            } else {
              const showBanner = bannerConfig.showTextLogo && width >= logoBase.width + 2;
              const showRose = bannerConfig.showRose && width >= roseBase.width + 2;
              if (showBanner) {
                for (let logoI = 0; logoI < logoBase.lines.length; logoI++) {
                  const logoLine = logoBase.lines[logoI];
                  b.addRow();
                  b.lines[b.lines.length - 1].push(
                    ...buildPenLogoLine(logoLine, logoI, logoBase.lines.length, tick),
                  );
                  b.center(width);
                }
                if (showRose) {
                  b.addRow();
                  b.center(width);
                }
              }
              if (showRose) {
                for (const roseLine of roseBase.lines) {
                  b.addRow();
                  b.add("rose", roseLine);
                  b.center(width);
                }
              }
            }

            if (state.mode === "full" || (!bannerConfig.showRose && !bannerConfig.showTextLogo)) {
              b.addRow();
              b.center(width);

              const fit = (v: unknown, w: number) =>
                String(v ?? "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, w)
                  .padEnd(w);
              const addWideRow = (
                l1: string,
                v1: string,
                l2: string,
                v2: string,
              ) => {
                b.addRow();
                b.add("label", fit(l1, 10));
                b.add("none", " ");
                b.add("value", fit(v1, 48));
                b.add("none", "   ");
                b.add("label", fit(l2, 12));
                b.add("none", " ");
                b.add("value", fit(v2, 46));
                b.center(width);
              };
              const narrowRows: Array<[string, string]> = [
                ["GIT:", gitBranch],
                ["PATH:", ctx.cwd],
                ["MCP:", `${mcpServersCount} server(s)`],
                ["AGENTS:", `${sddAgentsCount} phases`],
                ["PLUGINS:", `${packagesCount} package(s)`],
                ["SKILLS:", `${skills.length} loaded`],
                ["EXTENSIONS:", `${extensionsCount} active`],
                ["VER:", `v${VERSION}`],
                ["TOOLS:", `${customTools.length} custom`],
              ];
              const narrowLabelW = Math.max(...narrowRows.map(([l]) => l.length));
              const narrowValueW = Math.max(
                0,
                Math.min(
                  Math.max(...narrowRows.map(([, v]) => v.length)),
                  Math.max(8, width - narrowLabelW - 4),
                ),
              );
              const addNarrowRow = (label: string, value: string) => {
                b.addRow();
                b.add("label", label.padEnd(narrowLabelW));
                b.add("none", "  ");
                b.add("value", fit(value, narrowValueW));
                b.center(width);
              };

              if (wideStats) {
                addWideRow("GIT:", gitBranch, "PATH:", ctx.cwd);
                addWideRow(
                  "MCP:",
                  `${mcpServersCount} server(s)`,
                  "PLUGINS:",
                  `${packagesCount} package(s)`,
                );
                addWideRow(
                  "AGENTS:",
                  `${sddAgentsCount} phases`,
                  "EXTENSIONS:",
                  `${extensionsCount} active`,
                );
                addWideRow(
                  "SKILLS:",
                  `${skills.length} loaded`,
                  "TOOLS:",
                  `${customTools.length} custom`,
                );
                addWideRow("VER:", `v${VERSION}`, "", "");
              } else {
                addNarrowRow("GIT:", gitBranch);
                addNarrowRow("PATH:", ctx.cwd);
                addNarrowRow("MCP:", `${mcpServersCount} server(s)`);
                addNarrowRow("PLUGINS:", `${packagesCount} package(s)`);
                addNarrowRow("AGENTS:", `${sddAgentsCount} phases`);
                addNarrowRow("SKILLS:", `${skills.length} loaded`);
                addNarrowRow("EXTENSIONS:", `${extensionsCount} active`);
                addNarrowRow("VER:", `v${VERSION}`);
                addNarrowRow("TOOLS:", `${customTools.length} custom`);
              }

              b.addRow();
              b.center(width);
            }

            const out: string[] = [];
            const layout = b.lines;

            const logoRows = layout
              .map((row, idx) => ({
                idx,
                hasLogo: (row || []).some((c) => isLogoCellType(c.type)),
              }))
              .filter((r) => r.hasLogo)
              .map((r) => r.idx);
            const sparkleY =
              logoRows.length > 0
                ? logoRows[Math.floor(logoRows.length / 2)]
                : -1;
            const logoLastX = Math.max(
              -1,
              ...layout.map((row) => {
                let last = -1;
                for (let i = 0; i < (row || []).length; i++) {
                  const cell = row?.[i];
                  if (cell && isLogoCellType(cell.type) && cell.char !== " ") {
                    last = i;
                  }
                }
                return last;
              }),
            );

            const glintStartTick = WRITING_END_TICK + 3;
            const glintEndTick = WRITING_END_TICK + 12;
            const glintActive = tick >= glintStartTick && tick <= glintEndTick;
            const glintHead =
              ((tick - glintStartTick) /
                Math.max(1, glintEndTick - glintStartTick)) *
              (LOGO_BOUNDS.end - LOGO_BOUNDS.start + 1);
            const sparkleActive =
              tick >= WRITING_END_TICK + 13 && tick <= WRITING_END_TICK + 20;

            for (let y = 0; y < layout.length; y++) {
              const row = layout[y] || [];
              const firstLogoX = row.findIndex(
                (c) => isLogoCellType(c.type) && c.char !== " ",
              );
              let line = "";

              for (let x = 0; x < row.length; x++) {
                const cell = row[x] || { char: " ", type: "none" as const };
                if (cell.type === "raw") {
                  // Already fully rendered by paintWordmarkLine(); emit as-is.
                  line += cell.char;
                  continue;
                }
                if (cell.char === " ") {
                  line += " ";
                  continue;
                }

                if (cell.type === "rose") {
                  const pulse = 0.9 + Math.sin((x + y + frame) * 0.08) * 0.1;
                  const k = Math.max(0.01, roseOpacity * pulse);
                  const f = flashPhase ** 0.4;

                  const rBase = Math.floor(palette.rose[0] * k);
                  const gBase = Math.floor(palette.rose[1] * k);
                  const bBase = Math.floor(palette.rose[2] * k);

                  if (f > 0.85) {
                    line += `\x1b[1m\x1b[38;2;255;255;255m${cell.char}\x1b[0m`;
                  } else {
                    const r = Math.floor(rBase + (255 - rBase) * f);
                    const g = Math.floor(gBase + (255 - gBase) * f);
                    const bColor = Math.floor(bBase + (255 - bBase) * f);
                    line += rgb(r, g, bColor, cell.char);
                  }
                  continue;
                }

                if (isLogoCellType(cell.type)) {
                  const localLogoX = firstLogoX >= 0 ? x - firstLogoX : x;
                  const glintOnCell =
                    glintActive &&
                    localLogoX >= glintHead - 2 &&
                    localLogoX <= glintHead + 1;
                  const sparkleOnCell =
                    sparkleActive &&
                    y === sparkleY &&
                    (x === logoLastX || x === logoLastX - 1);

                  if (sparkleOnCell) {
                    line += `\x1b[1m` + rgb(255, 255, 255, "✦") + `\x1b[22m`;
                    continue;
                  }

                  if (glintOnCell) {
                    line += `\x1b[1m` + rgb(255, 245, 252, cell.char) + `\x1b[22m`;
                    continue;
                  }

                  if (cell.type === "logo-tip") {
                    line += `\x1b[1m` + rgb(255, 205, 238, cell.char) + `\x1b[22m`;
                  } else if (cell.type === "logo-fresh") {
                    line += cell.char === "▒"
                      ? paletteColor(bannerConfig.color, "logoDim", cell.char)
                      : paletteColor(bannerConfig.color, "logoFresh", cell.char);
                  } else {
                    line += cell.char === "▒"
                      ? paletteColor(bannerConfig.color, "logoDim", cell.char)
                      : paletteColor(bannerConfig.color, "value", cell.char);
                  }
                  continue;
                }

                switch (cell.type) {
                  case "label":
                    line += paletteColor(bannerConfig.color, "label", cell.char);
                    break;
                  case "value":
                    line += paletteColor(bannerConfig.color, "value", cell.char);
                    break;
                  case "dim":
                    line += theme.fg("dim", cell.char);
                    break;
                  case "accent":
                    line += theme.fg("accent", cell.char);
                    break;
                  default:
                    line += cell.char;
                }
              }

              out.push(truncateToWidth(line, Math.max(1, width), ""));
            }

            headerCache = { key: headerKey, out };
            return out;
          },
          invalidate() { headerCache = null; },
          dispose() {
            cleanup();
          },
        };
      });
      // Detection arms only now, right after setHeader() returned -- never
      // before, or a deliberate skip (no wordmark, undersized terminal)
      // would be misreported as a takeover. unref() so this timer never
      // keeps the process alive on its own.
      ownership.installed = true;
      setTimeout(() => {
        const verdict = headerOwnershipVerdict(ownership);
        // Detection only reports; it never reinstalls, retries, or changes
        // what is painted -- reinstalling is the setHeader race this work
        // removed. Quiet by default: "owned" and "not-installed" notify no
        // one, and "taken" notifies at most once per session.
        if (verdict === "taken" && !ownershipReported && ctx.hasUI) {
          ownershipReported = true;
          ctx.ui.notify(
            "Another extension replaced the startup header. gentle-pi will not reinstall it (see /gentle:banner).",
            "info",
          );
        }
      }, HEADER_OWNERSHIP_GRACE_MS)?.unref?.();
    }, 50);
  });
}
