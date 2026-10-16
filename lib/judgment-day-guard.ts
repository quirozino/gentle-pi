// Judgment Day runs on its own agents so each judge keeps the model its
// profile assigns (jd-judge-a and jd-judge-b differ on purpose: blind review
// needs independent models). A launch that labels a generic agent "judge"
// silently runs both judges on that agent's model, so it is refused.

export const JUDGMENT_DAY_AGENTS: readonly string[] = ["jd-judge-a", "jd-judge-b", "jd-fix-agent"];

const LABEL_PATTERN = /judgment[\s-]?day/i;
const TASK_PATTERN = /judgment[\s-]?day\s+(?:judge|fix)/i;

/** The block reason for a subagent_run that is a Judgment Day launch on another agent, else undefined. */
export function judgmentDayAgentBlock(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { agent, label, task } = input as { agent?: unknown; label?: unknown; task?: unknown };
	if (typeof agent !== "string" || JUDGMENT_DAY_AGENTS.includes(agent)) return undefined;
	const isJudgmentDay = (typeof label === "string" && LABEL_PATTERN.test(label))
		|| (typeof task === "string" && TASK_PATTERN.test(task));
	if (!isJudgmentDay) return undefined;
	return `Judgment Day launches must use their own agents, not "${agent}": run judge A as jd-judge-a, judge B as jd-judge-b, and fixes as jd-fix-agent, so each keeps the model its profile assigns.`;
}
