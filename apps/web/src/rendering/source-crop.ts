import type { ParamValues } from "@/params";
import { clamp } from "@/utils/math";

export type NormalizedSourceCrop = {
	x: number;
	y: number;
	width: number;
	height: number;
};

const MIN_NORM = 0.001;

function readNum({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const v = params[key];
	return typeof v === "number" && !Number.isNaN(v) ? v : fallback;
}

export function readNormalizedSourceCropFromParams({
	params,
}: {
	params: ParamValues;
}): NormalizedSourceCrop {
	const raw = {
		x: readNum({ params, key: "sourceCrop.x", fallback: 0 }),
		y: readNum({ params, key: "sourceCrop.y", fallback: 0 }),
		width: readNum({ params, key: "sourceCrop.width", fallback: 1 }),
		height: readNum({ params, key: "sourceCrop.height", fallback: 1 }),
	};
	return clampNormalizedSourceCrop({ crop: raw });
}

export function clampNormalizedSourceCrop({
	crop,
}: {
	crop: NormalizedSourceCrop;
}): NormalizedSourceCrop {
	const x = clamp({ value: crop.x, min: 0, max: 1 });
	const y = clamp({ value: crop.y, min: 0, max: 1 });
	const maxW = 1 - x;
	const maxH = 1 - y;
	const width = clamp({
		value: crop.width,
		min: MIN_NORM,
		max: maxW,
	});
	const height = clamp({
		value: crop.height,
		min: MIN_NORM,
		max: maxH,
	});
	return { x, y, width, height };
}

export function isFullSourceCrop({ crop }: { crop: NormalizedSourceCrop }): boolean {
	const c = clampNormalizedSourceCrop({ crop });
	return (
		c.x === 0 &&
		c.y === 0 &&
		Math.abs(c.width - 1) < 1e-4 &&
		Math.abs(c.height - 1) < 1e-4
	);
}

export type PixelRect = { x: number; y: number; width: number; height: number };

export function normalizedCropToPixelRect({
	crop,
	fullWidth,
	fullHeight,
}: {
	crop: NormalizedSourceCrop;
	fullWidth: number;
	fullHeight: number;
}): PixelRect {
	const c = clampNormalizedSourceCrop({ crop });
	let x = Math.floor(c.x * fullWidth);
	let y = Math.floor(c.y * fullHeight);
	let width = Math.round(c.width * fullWidth);
	let height = Math.round(c.height * fullHeight);
	width = Math.max(1, width);
	height = Math.max(1, height);
	x = clamp({ value: x, min: 0, max: Math.max(0, fullWidth - 1) });
	y = clamp({ value: y, min: 0, max: Math.max(0, fullHeight - 1) });
	width = Math.min(width, fullWidth - x);
	height = Math.min(height, fullHeight - y);
	width = Math.max(1, width);
	height = Math.max(1, height);
	return { x, y, width, height };
}

/**
 * Matches {@link normalizedCropToPixelRect} + compositor integer rounding for overlay alignment.
 */
export function snapNormalizedCropToRenderedPixels({
	crop,
	fullWidth,
	fullHeight,
}: {
	crop: NormalizedSourceCrop;
	fullWidth: number;
	fullHeight: number;
}): NormalizedSourceCrop {
	if (fullWidth <= 0 || fullHeight <= 0) {
		return clampNormalizedSourceCrop({ crop });
	}
	const pixelCrop = normalizedCropToPixelRect({
		crop,
		fullWidth,
		fullHeight,
	});
	return clampNormalizedSourceCrop({
		crop: {
			x: pixelCrop.x / fullWidth,
			y: pixelCrop.y / fullHeight,
			width: pixelCrop.width / fullWidth,
			height: pixelCrop.height / fullHeight,
		},
	});
}

export type CropHandleKind =
	| "move"
	| "nw"
	| "n"
	| "ne"
	| "e"
	| "se"
	| "s"
	| "sw"
	| "w";

export function canvasDeltaToNormalizedDelta({
	canvasDx,
	canvasDy,
	fullBounds,
}: {
	canvasDx: number;
	canvasDy: number;
	fullBounds: { width: number; height: number; rotation: number };
}): { nx: number; ny: number } {
	const rad = (-fullBounds.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const localDx = canvasDx * cos - canvasDy * sin;
	const localDy = canvasDx * sin + canvasDy * cos;
	const fw = fullBounds.width;
	const fh = fullBounds.height;
	if (fw === 0 || fh === 0) {
		return { nx: 0, ny: 0 };
	}
	return { nx: localDx / fw, ny: localDy / fh };
}

export function applyCropHandlePreview({
	kind,
	startCrop,
	dnx,
	dny,
}: {
	kind: CropHandleKind;
	startCrop: NormalizedSourceCrop;
	dnx: number;
	dny: number;
}): NormalizedSourceCrop {
	const s = startCrop;
	switch (kind) {
		case "move": {
			let nx = s.x + dnx;
			let ny = s.y + dny;
			nx = clamp({ value: nx, min: 0, max: 1 - s.width });
			ny = clamp({ value: ny, min: 0, max: 1 - s.height });
			return clampNormalizedSourceCrop({
				crop: { x: nx, y: ny, width: s.width, height: s.height },
			});
		}
		case "se":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x,
					y: s.y,
					width: s.width + dnx,
					height: s.height + dny,
				},
			});
		case "e":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x,
					y: s.y,
					width: s.width + dnx,
					height: s.height,
				},
			});
		case "s":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x,
					y: s.y,
					width: s.width,
					height: s.height + dny,
				},
			});
		case "nw":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x + dnx,
					y: s.y + dny,
					width: s.width - dnx,
					height: s.height - dny,
				},
			});
		case "n":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x,
					y: s.y + dny,
					width: s.width,
					height: s.height - dny,
				},
			});
		case "w":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x + dnx,
					y: s.y,
					width: s.width - dnx,
					height: s.height,
				},
			});
		case "ne":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x,
					y: s.y + dny,
					width: s.width + dnx,
					height: s.height - dny,
				},
			});
		case "sw":
			return clampNormalizedSourceCrop({
				crop: {
					x: s.x + dnx,
					y: s.y,
					width: s.width - dnx,
					height: s.height + dny,
				},
			});
	}
}
