// pi core's startup listing ([Skills], [Prompts], [Extensions] and the
// conflict/issue sections) is built by InteractiveMode.showLoadedResources()
// as Text components with paddingX 0, while every other line pi writes into
// the transcript (showStatus notices, assistant text) uses paddingX 1. The
// listing therefore sits one column left of everything else, framed or not.
//
// This patch wraps showLoadedResources so each zero-padded Text section in
// loadedResourcesContainer gets paddingX 1: the same left inset and the same
// wrap width (Text pads both sides) as pi's status text.
//
// /reload reloads extensions but NOT pi's own classes, so the prototype may
// already carry an older build of this patch. Keep the pristine method under
// STARTUP_LISTING_MARGIN_ORIGINAL and re-wrap it whenever the version moves.

export const STARTUP_LISTING_MARGIN_VERSION = "1";
export const STARTUP_LISTING_MARGIN_VERSION_FLAG = "__gentleStartupListingMarginVersion";
export const STARTUP_LISTING_MARGIN_ORIGINAL = "__gentleStartupListingMarginOriginal";
import { notePiContractMissing } from "./pi-contracts.ts";

const LISTING_PADDING_X = 1;

type PaddedChild = { paddingX?: unknown; invalidate?: () => void };
type ListingHost = { loadedResourcesContainer?: { children?: PaddedChild[] } };
type ListingMethod = (this: ListingHost, ...args: unknown[]) => unknown;

export function padListingChildren(host: ListingHost): void {
	const children = host.loadedResourcesContainer?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		if (child?.paddingX !== 0) continue;
		child.paddingX = LISTING_PADDING_X;
		child.invalidate?.();
	}
}

export function installStartupListingMargin(modeClass: { prototype: object } | undefined): void {
	const proto = modeClass?.prototype as (Record<string, unknown> & { showLoadedResources?: unknown }) | undefined;
	if (!proto) return;
	if (typeof proto.showLoadedResources !== "function") {
		// Contract gone (pi renamed/removed it): leave pi's listing stock.
		notePiContractMissing("startup-listing-padding", "InteractiveMode.prototype.showLoadedResources is not a function");
		return;
	}
	if (proto[STARTUP_LISTING_MARGIN_VERSION_FLAG] === STARTUP_LISTING_MARGIN_VERSION) return;
	const stored = proto[STARTUP_LISTING_MARGIN_ORIGINAL];
	const original = (typeof stored === "function" ? stored : proto.showLoadedResources) as ListingMethod;
	proto[STARTUP_LISTING_MARGIN_ORIGINAL] = original;
	proto.showLoadedResources = function showLoadedResourcesWithMargin(this: ListingHost, ...args: unknown[]) {
		const result = original.apply(this, args);
		padListingChildren(this);
		return result;
	};
	proto[STARTUP_LISTING_MARGIN_VERSION_FLAG] = STARTUP_LISTING_MARGIN_VERSION;
}
