"use client";

import { usePreviewViewport } from "@/preview/components/preview-viewport";
import {
	getCornerPosition,
	getEdgeHandlePosition,
} from "@/preview/element-bounds";
import {
	BoundingBoxOutline,
	CornerHandle,
	EdgeHandle,
	HandleButton,
	HANDLE_HIT_AREA_SIZE,
	getResizeCursor,
} from "./handle-primitives";
import {
	CROP_CORNERS,
	CROP_SIDES_LR,
	cornerToCropHandleKind,
	edgeToCropHandleKind,
	getTopEdgeCenter,
	useVideoCropHandles,
} from "@/crop/use-video-crop-handles";
import { cn } from "@/utils/ui";

export function CropHandles() {
	const viewport = usePreviewViewport();
	const {
		selectedVideo,
		fullBounds,
		cropBounds,
		handleKindPointerDown,
		handlePointerMove,
		handlePointerUp,
	} = useVideoCropHandles();

	if (!selectedVideo || !fullBounds || !cropBounds) return null;

	const displayScale = viewport.getDisplayScale();

	const toOverlay = ({
		canvasX,
		canvasY,
	}: {
		canvasX: number;
		canvasY: number;
	}) => viewport.canvasToOverlay({ canvasX, canvasY });

	const fullCenter = toOverlay({ canvasX: fullBounds.cx, canvasY: fullBounds.cy });
	const fullW = Math.abs(fullBounds.width) * displayScale.x;
	const fullH = Math.abs(fullBounds.height) * displayScale.y;

	const cropCenter = toOverlay({ canvasX: cropBounds.cx, canvasY: cropBounds.cy });
	const cropW = Math.abs(cropBounds.width) * displayScale.x;
	const cropH = Math.abs(cropBounds.height) * displayScale.y;

	const onMove = (event: React.PointerEvent) => handlePointerMove(event);
	const onUp = (event: React.PointerEvent) => handlePointerUp();

	return (
		<div
			className="pointer-events-none absolute inset-0 overflow-hidden"
			aria-hidden
		>
			<BoundingBoxOutline
				center={fullCenter}
				outlineWidth={fullW}
				outlineHeight={fullH}
				rotation={fullBounds.rotation}
				dashed
			/>
			<BoundingBoxOutline
				center={cropCenter}
				outlineWidth={cropW}
				outlineHeight={cropH}
				rotation={cropBounds.rotation}
				cursor="move"
				onPointerDown={(event) =>
					handleKindPointerDown({ event, kind: "move" })
				}
				onPointerMove={onMove}
				onPointerUp={onUp}
			/>
			{CROP_CORNERS.map((corner) => {
				const p = getCornerPosition({ bounds: cropBounds, corner });
				const screen = toOverlay({ canvasX: p.x, canvasY: p.y });
				const angleDeg =
					Math.atan2(screen.y - cropCenter.y, screen.x - cropCenter.x) *
					(180 / Math.PI);
				return (
					<CornerHandle
						key={corner}
						cursor={getResizeCursor({ angleDeg })}
						screen={screen}
						onPointerDown={(event) =>
							handleKindPointerDown({
								event,
								kind: cornerToCropHandleKind(corner),
							})
						}
						onPointerMove={onMove}
						onPointerUp={onUp}
					/>
				);
			})}
			{CROP_SIDES_LR.map((edge) => {
				const p = getEdgeHandlePosition({ bounds: cropBounds, edge });
				const screen = toOverlay({ canvasX: p.x, canvasY: p.y });
				return (
					<EdgeHandle
						key={edge}
						edge={edge}
						screen={screen}
						rotation={cropBounds.rotation}
						onPointerDown={(event) =>
							handleKindPointerDown({
								event,
								kind: edgeToCropHandleKind(edge),
							})
						}
						onPointerMove={onMove}
						onPointerUp={onUp}
					/>
				);
			})}
			{(() => {
				const p = getTopEdgeCenter({ bounds: cropBounds });
				const screen = toOverlay({ canvasX: p.x, canvasY: p.y });
				return (
					<HandleButton
						key="top"
						screen={screen}
						cursor="ns-resize"
						hitAreaSize={HANDLE_HIT_AREA_SIZE}
						onPointerDown={(event) =>
							handleKindPointerDown({ event, kind: "n" })
						}
						onPointerMove={onMove}
						onPointerUp={onUp}
					>
						<div
							className={cn("rounded-sm bg-white")}
							style={{
								width: 14,
								height: 6,
								transform: `rotate(${cropBounds.rotation}deg)`,
							}}
						/>
					</HandleButton>
				);
			})()}
			{(() => {
				const p = getEdgeHandlePosition({ bounds: cropBounds, edge: "bottom" });
				const screen = toOverlay({ canvasX: p.x, canvasY: p.y });
				return (
					<EdgeHandle
						key="bottom"
						edge="bottom"
						screen={screen}
						rotation={cropBounds.rotation}
						onPointerDown={(event) =>
							handleKindPointerDown({ event, kind: "s" })
						}
						onPointerMove={onMove}
						onPointerUp={onUp}
					/>
				);
			})()}
		</div>
	);
}
