import assert from "node:assert/strict";
import test from "node:test";
import { inferOddPhase } from "../lib/odd-phase-inference.ts";

// Deterministic, conservative tool -> ODD phase mapping for the Gentle Shell
// working label. Unknown tools and ambiguous shell commands never change it.

test("read-only file tools infer exploring", () => {
	for (const tool of ["read", "grep", "find", "ls", "codegraph"]) {
		assert.equal(inferOddPhase(tool, { path: "src/index.ts" }), "exploring", tool);
	}
});

test("asking the user infers deciding", () => {
	assert.equal(inferOddPhase("ask_user_choice", {}), "deciding");
	assert.equal(inferOddPhase("ask_user_question", {}), "deciding");
});

test("todo and edits to ODD feature documents infer planning", () => {
	assert.equal(inferOddPhase("todo", { items: [] }), "planning");
	assert.equal(inferOddPhase("write", { path: "odd/tasks/feature.md" }), "planning");
	assert.equal(inferOddPhase("edit", { path: "/repo/odd/tasks/feature.md" }), "planning");
	assert.equal(inferOddPhase("edit", { path: "C:\\repo\\odd\\tasks\\feature.md" }), "planning");
});

test("edits and writes to other paths infer implementing", () => {
	assert.equal(inferOddPhase("edit", { path: "lib/odd-phase.ts" }), "implementing");
	assert.equal(inferOddPhase("write", { path: "tests/new.test.ts" }), "implementing");
	assert.equal(inferOddPhase("write", {}), "implementing", "a write without a readable path is still a write");
	assert.equal(inferOddPhase("edit", undefined), "implementing");
});

test("native review tools infer checking", () => {
	for (const tool of ["gentle_review", "gentle_review_scope", "gentle_review_capture", "gentle_review_capture_group"]) {
		assert.equal(inferOddPhase(tool, {}), "checking", tool);
	}
});

test("shell test, typecheck, lint, and build commands infer checking", () => {
	for (const command of [
		"pnpm test",
		"npm test",
		"npm run test -- --watch=false",
		"node --experimental-strip-types --test tests/odd-phase.test.ts",
		"npx vitest run",
		"jest --ci",
		"go test ./...",
		"cargo test",
		"python -m pytest -q",
		"pytest tests/",
		"tsc --noEmit",
		"pnpm typecheck",
		"node scripts/check-types.mjs",
		"pnpm lint",
		"eslint .",
		"npm run build",
		"go build ./...",
		"make",
		"cd sub && make check",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	assert.equal(inferOddPhase("powershell", { command: "npm test" }), "checking");
});

test("waiting on or reading CI results infers checking", () => {
	for (const command of [
		"gh pr checks 1511",
		"gh pr checks 1511 --repo owner/name --watch --interval 20",
		"sleep 30; gh pr checks 1511 --watch 2>&1 | tail -10",
		"gh run watch 123",
		"gh run view 123 --log-failed",
		"gh run list --branch main",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "checking", command);
	}
	for (const command of ["gh pr view 1511", "gh pr diff 1511", "gh issue list"]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("read-only shell inspection infers exploring", () => {
	for (const command of [
		"git status",
		"git log --oneline -5",
		"git diff --stat",
		"git show HEAD",
		"git branch -a",
		"ls -la",
		"cat package.json",
		"head -20 README.md",
		"tail -n 5 log.txt",
		"grep -rn foo lib",
		"rg oddPhase",
		"find . -name '*.ts'",
		"wc -l lib/odd-phase.ts",
		"pwd",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

test("a checking segment wins over an exploring segment in the same command", () => {
	assert.equal(inferOddPhase("bash", { command: "git status && pnpm test" }), "checking");
	assert.equal(inferOddPhase("bash", { command: "pnpm test | tail -20" }), "checking");
});

// Real compound commands an orchestrator ran during one live session: loops,
// command substitutions, quoted pipes, and stderr redirects are routine, so
// read-only inspection must still read as exploring.
test("real compound read-only shell commands infer exploring", () => {
	for (const command of [
		`cd /repo && git rev-parse --show-toplevel && ls -d .codegraph 2>/dev/null; git log -1 --oneline; grep -rniI "bridge" --include=*.ts -l . 2>/dev/null | grep -v node_modules | head -30`,
		`ls ~/work | grep -i -E "shell|pi"; for d in ~/work/a ~/dev/b; do [ -d $d ] && echo "== $d" && cd $d && git log -1 --oneline && grep -rniI "bridge" -l . 2>/dev/null | grep -v node_modules | head -20; done`,
		`cd ~/w && grep -rniI "bridge" src | grep -v test | head -15; echo ===; cat ~/.config/settings.json 2>/dev/null | head -40; cd ~/repo && git branch -a --contains 6776520be 2>/dev/null | head`,
		`f=~/.local/bin/tool; ls -la $f; file -h $f; readlink -f $f; head -c 1500 "$(readlink -f $f)" | strings | head -40`,
		`which -a pi; readlink -f "$(which pi)"; cd ~/work/pi 2>/dev/null && git branch --show-current && git rev-list --left-right --count HEAD...origin/main 2>/dev/null`,
		`ps -axo pid,command | grep -E "gentle-shell|pi-coding-agent|/pi " | grep -v grep | cut -c1-300; echo ===; cd ~/w && grep -n "isInteractiveMode" -A8 lib/rpc-host.ts | head -30`,
		`pgrep -P 96445; for p in 96445 $(pgrep -P 96445); do echo "== $p"; ps -o command= -p $p | cut -c1-250; lsof -p $p 2>/dev/null | grep -E "lib/(a|b)" | awk '{print $NF}' | sort -u | head; done`,
		`d=~/.sessions; for x in $(grep -l "probe" $(find $d -name "*.jsonl" -mmin -120) 2>/dev/null); do echo "== $x"; grep -o '"toolName":"[^"]*"' $x | sort | uniq -c; done`,
		`cd ~/w && git tag --contains 53d62fbf3 | head; git log -1 --format='%h %ad' --date=short 53d62fbf3; git tag --sort=-creatordate | head -3`,
		`git -C ~/w remote -v && git worktree list && git stash list && git config --get user.name && gh pr view 1415 && jq .version package.json && sed -n '1,20p' README.md`,
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
});

// A command that clearly changes files, the index, or dependencies is work in
// progress: implementing, even when it also inspects (one write is enough).
test("clearly mutating shell commands infer implementing", () => {
	for (const command of [
		"git commit -m 'feat: x'",
		`git add f && git commit -q -m "x" && git log --oneline -3`,
		"git add -A",
		"git mv a.ts b.ts",
		"git rm --cached f",
		"git restore --staged f",
		"git checkout -- lib/a.ts",
		"git checkout HEAD -- lib/a.ts",
		"git apply fix.patch",
		"patch -p1 < fix.patch",
		"sed -i '' 's/a/b/' odd/tasks/f.md && grep -n x odd/tasks/f.md",
		"sed --in-place 's/a/b/' f",
		"ln -s ~/a node_modules && echo linked",
		"mv a b",
		"cp -r a b",
		"rm -rf dist",
		"ls && rm -rf dist",
		"mkdir -p lib/x",
		"touch marker",
		"echo hi | tee out.txt",
		"echo hi > out.txt",
		"echo hi >> out.txt",
		"git diff 2>&1 > out.diff",
		"sort -o out.txt in.txt",
		"cat >> f.md <<'EOF'\nhello\nEOF",
		"x=$(rm -rf dist); echo $x",
		`for f in *.ts; do grep -l x "$f" && rm "$f"; done`,
		"ls $(touch marker)",
		"pnpm install",
		"npm i -D typescript",
		"pnpm add zod",
		"yarn install --frozen-lockfile",
		"npm ci",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "implementing", command);
	}
});

// A write counts as implementing only when it can touch the project: temp
// and sink targets (/tmp, /var/tmp, $TMPDIR, a scratchpad, /dev/null, or a
// path from $(mktemp)) are scratch work, not implementation.
test("writes whose targets are all temp or sink paths never infer implementing", () => {
	for (const command of [
		"echo hi > /tmp/out.txt",
		"cat f >> /var/tmp/log",
		`echo x > "$TMPDIR/a"`,
		"echo x > ${TMPDIR}/a",
		"echo x > $TMPDIR",
		"cp lib/a.ts /tmp/a.ts",
		"mkdir -p /tmp/claude-1000/repo/scratchpad/run",
		"touch /home/u/.cache/session/scratchpad/marker",
		"rm -rf /tmp/build-x",
		"rm -f /tmp/a /var/tmp/b",
		"mv /tmp/a /tmp/b",
		"sed -i 's/a/b/' /tmp/f",
		"sort -o /tmp/s in.txt",
		"git diff | tee /tmp/d.diff",
		"git diff | tee /dev/null",
		"t=$(mktemp); echo x > $t",
		`d=$(mktemp -d) && cp lib/a.ts "$d/a.ts"`,
		"f=$(mktemp /tmp/x.XXXX) && echo x > \"${f}\"",
		`echo x > "$(mktemp)"`,
		"cat <<'EOF' > /tmp/plan.md\nrm -rf dist\nEOF",
	]) {
		assert.notEqual(inferOddPhase("bash", { command }), "implementing", command);
	}
	// A read-only command that saves its output to scratch is still exploring.
	assert.equal(inferOddPhase("bash", { command: "git diff > /tmp/x.diff" }), "exploring");
	assert.equal(inferOddPhase("bash", { command: "git log --oneline | tee /tmp/log.txt" }), "exploring");
});

test("a write that reaches any project path still infers implementing", () => {
	for (const command of [
		"cp lib/a.ts /tmp/a && cp lib/a.ts lib/b.ts",
		"echo x | tee /tmp/a lib/b.ts",
		"rm -rf /tmp/x dist",
		"mv /tmp/a lib/a.ts",
		"cp /tmp/a lib/a.ts",
		"echo x > /tmp/a; echo y > out.txt",
		`t=$(mktemp); cp lib/a.ts "$t" && mv "$t" lib/a.ts`,
		"echo x > /tmp/../home/u/repo/f",
		"echo x > /tmpx/a",
		"echo x > $HOME/repo/f",
		"git add /tmp/x",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "implementing", command);
	}
});

test("a checking segment still wins over a mutating segment", () => {
	assert.equal(inferOddPhase("bash", { command: "pnpm install && pnpm test" }), "checking");
	assert.equal(inferOddPhase("bash", { command: "rm -rf dist && npm run build" }), "checking");
	assert.equal(inferOddPhase("bash", { command: "node --test tests/a.test.ts > out.log" }), "checking");
});

// Redirections that write nothing, a `>` inside quoted text, here-strings,
// and heredoc bodies are not writes: they must not read as implementing.
test("harmless redirections, quoted text, here-strings and heredoc bodies are not writes", () => {
	for (const command of [
		"ls 2>&1",
		"cat f >/dev/null",
		"cat f > /dev/null 2>&1",
		"grep x f &>/dev/null",
		"echo err >&2 && ls",
		"grep '>' f",
		`grep ">" f`,
		"grep -c \\> f",
		"git log --format='%h > %s' -3",
		`cat <<< "a > b"`,
		`grep -c x <<< "$v"`,
		"cat <<'EOF' | grep x\nrm -rf dist > out\nEOF",
		"cat <<-EOF | head -1\n\ttouch x\n\tEOF",
		"[[ a > b ]] && ls",
	]) {
		assert.equal(inferOddPhase("bash", { command }), "exploring", command);
	}
	assert.equal(inferOddPhase("bash", { command: `echo "a > b"` }), undefined, "a quoted > in a no-op stays a no-op");
});

test("ambiguous shell commands that are not clear writes leave the label unchanged", () => {
	for (const command of [
		"git switch main 2>&1 && git pull --ff-only 2>&1 | tail -3",
		"git push",
		"git tag v1.0",
		"git branch new-branch",
		"git remote add origin https://example.com/r.git",
		"git config user.name someone",
		"git checkout main",
		"grep x f | xargs rm",
		"curl https://example.com",
		"echo hello",
		"",
	]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
	assert.equal(inferOddPhase("bash", {}), undefined);
	assert.equal(inferOddPhase("bash", { command: 42 }), undefined);
	assert.equal(inferOddPhase("bash", undefined), undefined);
});

// Inference runs synchronously on tool_execution_start, so a pathological
// command must never backtrack exponentially and freeze the host.
test("adversarial assignment runs classify in bounded time", () => {
	for (const command of ["a=".repeat(26) + '"', "a=".repeat(26) + "\\\"", "a=".repeat(26) + "'"]) {
		const start = performance.now();
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
		assert.ok(performance.now() - start < 50, `${command} took ${performance.now() - start}ms`);
	}
});

test("no-op-only commands leave the label unchanged", () => {
	for (const command of ["sleep 4", "echo ===", "cd /repo && echo done", "true"]) {
		assert.equal(inferOddPhase("bash", { command }), undefined, command);
	}
});

test("known delegated agents infer the parent work phase in foreground and background", () => {
	for (const [agent, phase] of [
		["gentle-ai-worker", "implementing"],
		["gentle-ai-verify", "checking"],
		["gentle-ai-explore", "exploring"],
	] as const) {
		for (const mode of ["task", "background"]) {
			assert.equal(inferOddPhase("subagent_run", { agent, mode, task: "untrusted task prose" }), phase);
		}
	}
});

test("unknown or malformed delegation arguments never infer from task prose", () => {
	for (const args of [
		{}, null, "gentle-ai-worker", { agent: 5 }, { agent: "gentle-ai-writer" },
		{ task: "gentle-ai-verify checking" }, { agent: "gentle-ai-verify-extra" },
	]) assert.equal(inferOddPhase("subagent_run", args), undefined);
	for (const tool of ["subagent_start", "subagent_wait", "gentle_odd_phase", "mem_save", "web_fetch", ""]) {
		assert.equal(inferOddPhase(tool, {}), undefined, tool);
	}
});

test("MCP-prefixed tool names are normalized before mapping", () => {
	assert.equal(inferOddPhase("mcp__custom-tools__read", { path: "a.ts" }), "exploring");
	assert.equal(inferOddPhase("mcp__custom-tools__edit", { path: "a.ts" }), "implementing");
	assert.equal(inferOddPhase("mcp__custom-tools__write", { path: "odd/tasks/f.md" }), "planning");
	assert.equal(inferOddPhase("mcp__custom-tools__bash", { command: "pnpm test" }), "checking");
	assert.equal(inferOddPhase("mcp__custom-tools__mem_save", {}), undefined);
	assert.equal(inferOddPhase("mcp__custom-tools__subagent_run", { agent: "gentle-ai-worker" }), "implementing");
});
