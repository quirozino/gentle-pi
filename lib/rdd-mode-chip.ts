// The receipt-driven development switch as an extension status, so the Status
// card lists it under Integrations next to the other integrations. Pure text:
// the shell paints every extension status through its muted status role.

export const RDD_STATUS_KEY = "gentle-rdd";
export const RDD_STATUS_GLYPH = "🌹";

/** The fields of `gentle-ai review mode status` this chip reads. */
export interface RddModeChipStatus {
	effective: unknown;
	source: unknown;
}

const SOURCE_LABEL: Record<string, string> = {
	default: "default",
	global: "global",
	clone_local: "clone",
};

/**
 * `🌹 RDD on (default)`, `🌹 RDD off (global)`, `🌹 RDD off (clone)`; anything
 * that is not a recognized on/off status with a known source (the native read
 * failed, timed out or answered an unknown shape) fails closed to
 * `🌹 RDD unknown`, never a guessed mode.
 */
export function rddModeChipText(status: RddModeChipStatus | undefined): string {
	const effective = status?.effective;
	const source = typeof status?.source === "string" ? SOURCE_LABEL[status.source] : undefined;
	if ((effective !== "on" && effective !== "off") || source === undefined) return `${RDD_STATUS_GLYPH} RDD unknown`;
	return `${RDD_STATUS_GLYPH} RDD ${effective} (${source})`;
}

interface StatusSink {
	ui?: { setStatus?: (key: string, text: string | undefined) => void };
}

/** Publishes the chip; a host without extension statuses is a silent no-op. */
export function publishRddModeChip(ctx: StatusSink, status: RddModeChipStatus | undefined): void {
	try {
		if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(RDD_STATUS_KEY, rddModeChipText(status));
	} catch {
		// Status chrome must never break a session or a command.
	}
}
