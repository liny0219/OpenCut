"use client";

import { useCallback, useRef, useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import {
	computeCropTransformCompensation,
	getVideoFullFrameBounds,
	getVideoVisibleBoundsForCrop,
	type Corner,
	type Edge,
	type ElementBounds,
} from "@/preview/element-bounds";
import { buildTransformFromParams } from "@/rendering";
import {
	applyCropHandlePreview,
	canvasDeltaToNormalizedDelta,
	clampNormalizedSourceCrop,
	type CropHandleKind,
	type NormalizedSourceCrop,
	readNormalizedSourceCropFromParams,
	snapNormalizedCropToRenderedPixels,
} from "@/rendering/source-crop";
import { videoCache } from "@/services/video-cache/service";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { useSyncExternalStore } from "react";

export function getTopEdgeCenter({ bounds }: { bounds: ElementBounds }): {
	x: number;
	y: number;
} {
	const halfH = bounds.height / 2;
	const rad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return {
		x: bounds.cx + halfH * sin,
		y: bounds.cy - halfH * cos,
	};
}

type DragState = {
	trackId: string;
	elementId: string;
	kind: CropHandleKind;
	startCanvasX: number;
	startCanvasY: number;
	startCrop: NormalizedSourceCrop;
};

export function useVideoCropHandles() {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const dragRef = useRef<DragState | null>(null);
	const captureRef = useRef<{ target: HTMLElement; pointerId: number } | null>(
		null,
	);

	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const sceneTracks = useEditor(
		(e) =>
			e.timeline.getPreviewTracks() ?? e.scenes.getActiveSceneOrNull()?.tracks,
	);
	const [, setEpoch] = useState(0);
	const bump = useCallback(() => setEpoch((n) => n + 1), []);

	useSyncExternalStore(
		(onStoreChange) => videoCache.subscribeDecodedCanvasSize(onStoreChange),
		() => videoCache.getDecodedCanvasSizeSnapshot(),
		() => videoCache.getDecodedCanvasSizeSnapshot(),
	);

	const selectedVideo =
		selectedElements.length === 1 && sceneTracks
			? (() => {
					const ref = selectedElements[0];
					const track = findTrackInSceneTracks({
						tracks: sceneTracks,
						trackId: ref.trackId,
					});
					const el = track?.elements.find((e) => e.id === ref.elementId);
					if (!el || el.type !== "video") return null;
					return { ref, element: el };
				})()
			: null;

	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor(
		(e) => e.project.getActive().settings.canvasSize,
	);

	const mediaAsset = selectedVideo
		? mediaAssets.find((a) => a.id === selectedVideo.element.mediaId)
		: undefined;

	const localTime =
		selectedVideo &&
		currentTime >= selectedVideo.element.startTime &&
		currentTime < selectedVideo.element.startTime + selectedVideo.element.duration
			? currentTime - selectedVideo.element.startTime
			: 0;

	const fullBounds = selectedVideo
		? getVideoFullFrameBounds({
				element: selectedVideo.element,
				canvasSize,
				mediaAsset,
				localTime,
			})
		: null;

	const cropNorm = selectedVideo
		? readNormalizedSourceCropFromParams({
				params: selectedVideo.element.params,
			})
		: null;

	const decoded = selectedVideo
		? videoCache.getDecodedCanvasSize({
				mediaId: selectedVideo.element.mediaId,
			})
		: null;

	// Solid crop box must match compositor layout (cropped source + contain +
	// transform). getCropRectBounds affine subset of fullBounds is wrong when
	// contain scale differs before/after crop.
	const cropBounds =
		selectedVideo && cropNorm
			? getVideoVisibleBoundsForCrop({
					element: selectedVideo.element,
					canvasSize,
					mediaAsset,
					localTime,
					crop: clampNormalizedSourceCrop({ crop: cropNorm }),
				})
			: null;

	const previewCropParams = useCallback(
		(
			crop: NormalizedSourceCrop,
			opts?: { kind: CropHandleKind | null },
		) => {
			if (!selectedVideo) return;
			const next = clampNormalizedSourceCrop({ crop });
			const kind = opts?.kind ?? null;
			let dPositionX = 0;
			let dPositionY = 0;
			if (kind && kind !== "move") {
				const prevCrop = readNormalizedSourceCropFromParams({
					params: selectedVideo.element.params,
				});
				const b0 = getVideoVisibleBoundsForCrop({
					element: selectedVideo.element,
					canvasSize,
					mediaAsset,
					localTime,
					crop: prevCrop,
				});
				const b1 = getVideoVisibleBoundsForCrop({
					element: selectedVideo.element,
					canvasSize,
					mediaAsset,
					localTime,
					crop: next,
				});
				if (b0 && b1) {
					const d = computeCropTransformCompensation({
						kind,
						before: b0,
						after: b1,
					});
					dPositionX = d.dPositionX;
					dPositionY = d.dPositionY;
				}
			}
			const baseTransform = buildTransformFromParams({
				params: selectedVideo.element.params,
			});
			editor.timeline.previewElements({
				updates: [
					{
						trackId: selectedVideo.ref.trackId,
						elementId: selectedVideo.ref.elementId,
						updates: {
							params: {
								...selectedVideo.element.params,
								"sourceCrop.x": next.x,
								"sourceCrop.y": next.y,
								"sourceCrop.width": next.width,
								"sourceCrop.height": next.height,
								"transform.positionX":
									baseTransform.position.x + dPositionX,
								"transform.positionY":
									baseTransform.position.y + dPositionY,
							},
						},
					},
				],
			});
			bump();
		},
		[
			editor.timeline,
			selectedVideo,
			bump,
			canvasSize,
			mediaAsset,
			localTime,
		],
	);

	const endDrag = useCallback(() => {
		const saved = dragRef.current;
		const wasDragging = saved !== null;
		dragRef.current = null;
		const cap = captureRef.current;
		if (cap) {
			try {
				cap.target.releasePointerCapture(cap.pointerId);
			} catch {
				/* */
			}
			captureRef.current = null;
		}
		if (!wasDragging || !saved) {
			return;
		}

		const tracks =
			editor.timeline.getPreviewTracks() ??
			editor.scenes.getActiveSceneOrNull()?.tracks;
		if (tracks) {
			const track = findTrackInSceneTracks({
				tracks,
				trackId: saved.trackId,
			});
			const el = track?.elements.find((e) => e.id === saved.elementId);
			if (el?.type === "video") {
				const dec = videoCache.getDecodedCanvasSize({
					mediaId: el.mediaId,
				});
				if (dec) {
					const c = readNormalizedSourceCropFromParams({
						params: el.params,
					});
					const snapped = snapNormalizedCropToRenderedPixels({
						crop: c,
						fullWidth: dec.width,
						fullHeight: dec.height,
					});
					let dPositionX = 0;
					let dPositionY = 0;
					if (saved.kind !== "move") {
						const project = editor.project.getActive();
						const assets = editor.media.getAssets();
						const asset = assets.find((a) => a.id === el.mediaId);
						const time = editor.playback.getCurrentTime();
						const lt =
							time >= el.startTime && time < el.startTime + el.duration
								? time - el.startTime
								: 0;
						const b0 = getVideoVisibleBoundsForCrop({
							element: el,
							canvasSize: project.settings.canvasSize,
							mediaAsset: asset,
							localTime: lt,
							crop: c,
						});
						const b1 = getVideoVisibleBoundsForCrop({
							element: el,
							canvasSize: project.settings.canvasSize,
							mediaAsset: asset,
							localTime: lt,
							crop: snapped,
						});
						if (b0 && b1) {
							const d = computeCropTransformCompensation({
								kind: saved.kind,
								before: b0,
								after: b1,
							});
							dPositionX = d.dPositionX;
							dPositionY = d.dPositionY;
						}
					}
					const baseTransform = buildTransformFromParams({
						params: el.params,
					});
					editor.timeline.previewElements({
						updates: [
							{
								trackId: saved.trackId,
								elementId: saved.elementId,
								updates: {
									params: {
										...el.params,
										"sourceCrop.x": snapped.x,
										"sourceCrop.y": snapped.y,
										"sourceCrop.width": snapped.width,
										"sourceCrop.height": snapped.height,
										"transform.positionX":
											baseTransform.position.x + dPositionX,
										"transform.positionY":
											baseTransform.position.y + dPositionY,
									},
								},
							},
						],
					});
				}
			}
		}
		editor.timeline.commitPreview();
	}, [editor]);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || !fullBounds) return;

			const pos = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!pos) return;

			const d = canvasDeltaToNormalizedDelta({
				canvasDx: pos.x - drag.startCanvasX,
				canvasDy: pos.y - drag.startCanvasY,
				fullBounds,
			});

			const next = applyCropHandlePreview({
				kind: drag.kind,
				startCrop: drag.startCrop,
				dnx: d.nx,
				dny: d.ny,
			});
			previewCropParams(next, { kind: drag.kind });
		},
		[viewport, fullBounds, previewCropParams],
	);

	const handlePointerUp = useCallback(() => {
		endDrag();
	}, [endDrag]);

	const handleKindPointerDown = useCallback(
		({
			event,
			kind,
		}: {
			event: React.PointerEvent;
			kind: CropHandleKind;
		}) => {
			if (!selectedVideo || !fullBounds) return;
			event.stopPropagation();
			event.preventDefault();
			const target = event.currentTarget as HTMLElement;
			target.setPointerCapture(event.pointerId);
			captureRef.current = { target, pointerId: event.pointerId };

			const pos = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!pos) return;

			dragRef.current = {
				trackId: selectedVideo.ref.trackId,
				elementId: selectedVideo.ref.elementId,
				kind,
				startCanvasX: pos.x,
				startCanvasY: pos.y,
				startCrop: readNormalizedSourceCropFromParams({
					params: selectedVideo.element.params,
				}),
			};
		},
		[selectedVideo, fullBounds, viewport],
	);



	return {
		selectedVideo: selectedVideo?.element ?? null,
		fullBounds,
		cropBounds,
		decodedSize: decoded,
		handleKindPointerDown,
		handlePointerMove,
		handlePointerUp,
		resetToFullFrame: () => {
			if (!selectedVideo) return;
			const full = { x: 0, y: 0, width: 1, height: 1 };
			previewCropParams(full);
			editor.timeline.commitPreview();
		},
	};
}

export const CROP_CORNERS: readonly Corner[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];

export const CROP_SIDES_LR: readonly Edge[] = ["left", "right"];

const CORNER_TO_KIND: Record<Corner, CropHandleKind> = {
	"top-left": "nw",
	"top-right": "ne",
	"bottom-left": "sw",
	"bottom-right": "se",
};

const EDGE_TO_KIND: Record<Edge, CropHandleKind> = {
	left: "w",
	right: "e",
	bottom: "s",
};

export function cornerToCropHandleKind(corner: Corner): CropHandleKind {
	return CORNER_TO_KIND[corner];
}

export function edgeToCropHandleKind(edge: Edge): CropHandleKind {
	return EDGE_TO_KIND[edge];
}
