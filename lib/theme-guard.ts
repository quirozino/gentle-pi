// pi falls back to its `system` theme silently when the configured theme fails
// to load, which also hides every panel gated on that theme. These helpers turn
// that silent fallback into one visible startup notice.

/**
 * The warning shown when the configured theme is not the one pi loaded, or
 * undefined when there is nothing to report: no configured theme, an unknown
 * loaded theme, or a match.
 */
export function themeFallbackNotice(configuredTheme: string | undefined, loadedThemeName: string | undefined): string | undefined {
	if (!configuredTheme || !loadedThemeName || configuredTheme === loadedThemeName) return undefined;
	return `Tema «${configuredTheme}» no cargó; pi usa «${loadedThemeName}». Revisa el paquete de temas.`;
}

export interface ConfiguredThemeSources {
	/** pi's effective settings API, when the host exposes it. */
	getSettings?: () => { theme?: unknown } | undefined;
	readFile(path: string): Promise<string>;
	/** pi's global settings file, read only when the API is missing or fails. */
	settingsPath: string;
}

/** The theme pi is configured to use, or undefined when it cannot be read. Never throws. */
export async function readConfiguredTheme(sources: ConfiguredThemeSources): Promise<string | undefined> {
	if (typeof sources.getSettings === "function") {
		try {
			const theme = sources.getSettings()?.theme;
			if (typeof theme === "string") return theme;
		} catch {
			// Fall through to the settings file.
		}
	}
	try {
		const theme = (JSON.parse(await sources.readFile(sources.settingsPath)) as { theme?: unknown } | null)?.theme;
		return typeof theme === "string" ? theme : undefined;
	} catch {
		return undefined;
	}
}

/** Notifies when the configured theme did not load. Resolves true when it notified; never rejects. */
export async function reportThemeFallback(options: {
	loadedThemeName: string | undefined;
	readConfiguredTheme: () => Promise<string | undefined>;
	notify: (message: string) => void;
}): Promise<boolean> {
	try {
		if (!options.loadedThemeName) return false;
		const notice = themeFallbackNotice(await options.readConfiguredTheme(), options.loadedThemeName);
		if (!notice) return false;
		options.notify(notice);
		return true;
	} catch {
		return false;
	}
}
