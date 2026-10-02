import { visibleWidth } from "@earendil-works/pi-tui";

// A tiny SGR emulator for background assertions: what background each visible
// cell of a rendered row ends up with ("default", or the SGR colour arguments).
const segmenter = new Intl.Segmenter();

/** The background of each visible cell: "default", our colour, or the explicit SGR text. */
export function cellBackgrounds(line: string): string[] {
	const cells: string[] = [];
	let bg = "default";
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\x1b") {
			const sgr = /^\x1b\[([0-9;:]*)m/u.exec(line.slice(index));
			if (sgr) {
				const params = sgr[1] === "" ? ["0"] : sgr[1]!.split(";");
				for (let p = 0; p < params.length; p++) {
					const value = params[p]!;
					if (value.includes(":")) {
						if (value.startsWith("48:")) bg = value;
					} else if (value === "0" || value === "" || value === "49") bg = "default";
					else if (value === "38" || value === "58") p += params[p + 1] === "5" ? 2 : 4;
					else if (value === "48") {
						const take = params[p + 1] === "5" ? 2 : 4;
						bg = params.slice(p + 1, p + 1 + take).join(";");
						p += take;
					} else if (/^(4[0-7]|10[0-7])$/u.test(value)) bg = value;
				}
				index += sgr[0].length;
				continue;
			}
			const other = /^\x1b(?:\[[0-9;?]*[A-Za-z]|[\]_][^\x07]*\x07)/u.exec(line.slice(index));
			index += other ? other[0].length : 1;
			continue;
		}
		const next = line.indexOf("\x1b", index);
		const text = line.slice(index, next === -1 ? undefined : next);
		for (const { segment } of segmenter.segment(text)) for (let w = 0; w < visibleWidth(segment); w++) cells.push(bg);
		index += text.length;
	}
	return cells;
}
