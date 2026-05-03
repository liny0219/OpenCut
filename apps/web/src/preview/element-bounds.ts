import type {
	SceneTracks,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { STICKER_INTRINSIC_SIZE_FALLBACK } from "@/stickers/intrinsic-size";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics";
import { measureTextElement } from "@/text/measure-element";
import {
	getElementLocalTime,
} from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import {
	clampNormalizedSourceCrop,
	normalizedCropToPixelRect,
	readNormalizedSourceCropFromParams,
	type CropHandleKind,
	type NormalizedSourceCrop,
} from "@/rendering/source-crop";
import { videoCache } from "@/services/video-cache/service";

export interface ElementBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface ElementWithBounds {
	trackId: string;
	elementId: string;
	element: TimelineElement;
	bounds: ElementBounds;
}

function getVisualElementBounds({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scaleX;
	const scaledHeight = sourceHeight * containScale * transform.scaleY;
	const cx = canvasWidth / 2 + transform.position.x;
	const cy = canvasHeight / 2 + transform.position.y;

	return {
		cx,
		cy,
		width: scaledWidth,
		height: scaledHeight,
		rotation: transform.rotate,
	};
}

function getTransformedRectBounds({
	canvasWidth,
	canvasHeight,
	rect,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	rect: { left: number; top: number; width: number; height: number };
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const localCenterX = rect.left + rect.width / 2;
	const localCenterY = rect.top + rect.height / 2;
	const scaledCenterX = localCenterX * transform.scaleX;
	const scaledCenterY = localCenterY * transform.scaleY;
	const rotationRad = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);
	return {
		cx:
			canvasWidth / 2 +
			transform.position.x +
			scaledCenterX * cos -
			scaledCenterY * sin,
		cy:
			canvasHeight / 2 +
			transform.position.y +
			scaledCenterX * sin +
			scaledCenterY * cos,
		width: rect.width * transform.scaleX,
		height: rect.height * transform.scaleY,
		rotation: transform.rotate,
	};
}

/**
 * Bounds policy: bounds reflect base content geometry (text glyphs + background,
 * sticker/image/video content area) and base transform. Post-effect spill (blur,
 * glow) and mask-clipped regions are intentionally excluded — handles manipulate
 * the canonical element geometry, not visual effect output.
 */
function getElementBounds({
	element,
	canvasSize,
	mediaAsset,
	localTime,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
	localTime: number;
}): ElementBounds | null {
	if (element.type === "audio" || element.type === "effect") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;

	if (element.type === "video") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		const crop = readNormalizedSourceCropFromParams({
			params: element.params,
		});
		const decoded = videoCache.getDecodedCanvasSize({
			mediaId: element.mediaId,
		});
		let sourceWidth: number;
		let sourceHeight: number;
		if (decoded) {
			const px = normalizedCropToPixelRect({
				crop,
				fullWidth: decoded.width,
				fullHeight: decoded.height,
			});
			sourceWidth = px.width;
			sourceHeight = px.height;
		} else {
			const iw = mediaAsset?.width ?? canvasWidth;
			const ih = mediaAsset?.height ?? canvasHeight;
			sourceWidth = iw * crop.width;
			sourceHeight = ih * crop.height;
		}
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	}

	if (element.type === "image") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		const sourceWidth = mediaAsset?.width ?? canvasWidth;
		const sourceHeight = mediaAsset?.height ?? canvasHeight;
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	}

	if (element.type === "sticker") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: element.intrinsicWidth ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			sourceHeight: element.intrinsicHeight ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			transform,
		});
	}

	if (element.type === "graphic") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
			sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
			transform,
		});
	}

	if (element.type === "text") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			localTime,
		});

		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;

		const measured = measureTextElement({
			element,
			canvasHeight,
			localTime,
			ctx,
		});

		return getTransformedRectBounds({
			canvasWidth,
			canvasHeight,
			rect: measured.visualRect,
			transform,
		});
	}

	return null;
}

function getVideoIntrinsicDimensionsForBounds({
	element,
	canvasSize,
	mediaAsset,
}: {
	element: Extract<TimelineElement, { type: "video" }>;
	canvasSize: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
}): { width: number; height: number } {
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const decoded = videoCache.getDecodedCanvasSize({
		mediaId: element.mediaId,
	});
	if (decoded) {
		return decoded;
	}
	return {
		width: mediaAsset?.width ?? canvasWidth,
		height: mediaAsset?.height ?? canvasHeight,
	};
}

export function getVideoFullFrameBounds({
	element,
	canvasSize,
	mediaAsset,
	localTime,
}: {
	element: VideoElement;
	canvasSize: { width: number; height: number };
	mediaAsset: MediaAsset | null | undefined;
	localTime: number;
}): ElementBounds | null {
	if ("hidden" in element && element.hidden) return null;
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});
	const { width: sourceWidth, height: sourceHeight } =
		getVideoIntrinsicDimensionsForBounds({
			element,
			canvasSize,
			mediaAsset,
		});
	return getVisualElementBounds({
		canvasWidth,
		canvasHeight,
		sourceWidth,
		sourceHeight,
		transform,
	});
}

/**
 * Visible layout bounds for a video element with an explicit source crop (same
 * model as the compositor: center is transform center, size follows cropped
 * source + contain scale).
 */
export function getVideoVisibleBoundsForCrop({
	element,
	canvasSize,
	mediaAsset,
	localTime,
	crop,
}: {
	element: VideoElement;
	canvasSize: { width: number; height: number };
	mediaAsset: MediaAsset | null | undefined;
	localTime: number;
	crop: NormalizedSourceCrop;
}): ElementBounds | null {
	if ("hidden" in element && element.hidden) return null;
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});
	const c = clampNormalizedSourceCrop({ crop });
	const decoded = videoCache.getDecodedCanvasSize({
		mediaId: element.mediaId,
	});
	let sourceWidth: number;
	let sourceHeight: number;
	if (decoded) {
		const px = normalizedCropToPixelRect({
			crop: c,
			fullWidth: decoded.width,
			fullHeight: decoded.height,
		});
		sourceWidth = px.width;
		sourceHeight = px.height;
	} else {
		const iw = mediaAsset?.width ?? canvasWidth;
		const ih = mediaAsset?.height ?? canvasHeight;
		sourceWidth = iw * c.width;
		sourceHeight = ih * c.height;
	}
	return getVisualElementBounds({
		canvasWidth,
		canvasHeight,
		sourceWidth,
		sourceHeight,
		transform,
	});
}

/**
 * When source crop changes but transform.position stays fixed, the layer
 * resizes around its center. Return the delta to add to transform.position
 * (canvas space) so the opposite edge / corner stays fixed for this handle.
 */
export function computeCropTransformCompensation({
	kind,
	before,
	after,
}: {
	kind: CropHandleKind;
	before: ElementBounds;
	after: ElementBounds;
}): { dPositionX: number; dPositionY: number } {
	if (kind === "move") {
		return { dPositionX: 0, dPositionY: 0 };
	}

	const w0 = before.width;
	const h0 = before.height;
	const w1 = after.width;
	const h1 = after.height;
	const cos = Math.cos((before.rotation * Math.PI) / 180);
	const sin = Math.sin((before.rotation * Math.PI) / 180);

	const halfDw = (w1 - w0) / 2;
	const halfDh = (h1 - h0) / 2;

	switch (kind) {
		case "e":
			return { dPositionX: halfDw * cos, dPositionY: halfDw * sin };
		case "w":
			return { dPositionX: -halfDw * cos, dPositionY: -halfDw * sin };
		case "s": {
			return {
				dPositionX: -halfDh * sin,
				dPositionY: halfDh * cos,
			};
		}
		case "n": {
			return {
				dPositionX: halfDh * sin,
				dPositionY: -halfDh * cos,
			};
		}
		case "se":
			return {
				dPositionX: halfDw * cos - halfDh * sin,
				dPositionY: halfDw * sin - halfDh * cos,
			};
		case "nw":
			return {
				dPositionX: -halfDw * cos + halfDh * sin,
				dPositionY: -halfDw * sin - halfDh * cos,
			};
		case "ne":
			return {
				dPositionX: halfDw * cos + halfDh * sin,
				dPositionY: halfDw * sin - halfDh * cos,
			};
		case "sw":
			return {
				dPositionX: -halfDw * cos - halfDh * sin,
				dPositionY: -halfDw * sin + halfDh * cos,
			};
		default:
			return { dPositionX: 0, dPositionY: 0 };
	}
}

export function getCropRectBounds({
	fullBounds,
	normalizedCrop,
}: {
	fullBounds: ElementBounds;
	normalizedCrop: NormalizedSourceCrop;
}): ElementBounds {
	const c = clampNormalizedSourceCrop({ crop: normalizedCrop });
	const fw = fullBounds.width;
	const fh = fullBounds.height;
	const localCx = -fw / 2 + (c.x + c.width / 2) * fw;
	const localCy = -fh / 2 + (c.y + c.height / 2) * fh;
	const cw = c.width * fw;
	const ch = c.height * fh;
	const rad = (fullBounds.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return {
		cx: fullBounds.cx + localCx * cos - localCy * sin,
		cy: fullBounds.cy + localCx * sin + localCy * cos,
		width: cw,
		height: ch,
		rotation: fullBounds.rotation,
	};
}

export const ROTATION_HANDLE_OFFSET = 24;

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Edge = "right" | "left" | "bottom";

export function getCornerPosition({
	bounds,
	corner,
}: {
	bounds: ElementBounds;
	corner: Corner;
}): { x: number; y: number } {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfW : halfW;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfH : halfH;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getEdgeHandlePosition({
	bounds,
	edge,
}: {
	bounds: ElementBounds;
	edge: Edge;
}): { x: number; y: number } {
	const halfWidth = bounds.width / 2;
	const halfHeight = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX = edge === "right" ? halfWidth : edge === "left" ? -halfWidth : 0;
	const localY = edge === "bottom" ? halfHeight : 0;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getVisibleElementsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	mediaAssets,
}: {
	tracks: SceneTracks;
	currentTime: number;
	canvasSize: { width: number; height: number };
	mediaAssets: MediaAsset[];
}): ElementWithBounds[] {
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));
	const orderedTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	].reverse();

	const result: ElementWithBounds[] = [];

	for (const track of orderedTracks) {
		const elements = track.elements
			.filter((element) => !("hidden" in element && element.hidden))
			.filter(
				(element) =>
					currentTime >= element.startTime &&
					currentTime < element.startTime + element.duration,
			)
			.slice()
			.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});

		for (const element of elements) {
			const localTime = getElementLocalTime({
				timelineTime: currentTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			});
			const mediaAsset =
				element.type === "video" || element.type === "image"
					? mediaMap.get(element.mediaId)
					: undefined;
			const bounds = getElementBounds({
				element,
				canvasSize,
				mediaAsset,
				localTime,
			});
			if (bounds) {
				result.push({
					trackId: track.id,
					elementId: element.id,
					element,
					bounds,
				});
			}
		}
	}

	return result;
}
