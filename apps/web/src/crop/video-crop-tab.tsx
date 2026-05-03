"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ElementParamsTab } from "@/components/editor/panels/properties/components/element-params-tab";
import { useEditor } from "@/editor/use-editor";
import type { VideoElement } from "@/timeline";

const CROP_PARAM_KEYS = [
	"sourceCrop.x",
	"sourceCrop.y",
	"sourceCrop.width",
	"sourceCrop.height",
] as const;

export function VideoCropTab({
	element,
	trackId,
}: {
	element: VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const resetToFullFrame = useCallback(() => {
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						params: {
							...element.params,
							"sourceCrop.x": 0,
							"sourceCrop.y": 0,
							"sourceCrop.width": 1,
							"sourceCrop.height": 1,
						},
					},
				},
			],
		});
		editor.timeline.commitPreview();
	}, [editor.timeline, trackId, element.id, element.params]);

	return (
		<div className="flex flex-col gap-1">
			<p className="text-muted-foreground px-4 pt-3 text-xs">
				Drag handles in the preview, or edit values below. Coordinates are
				normalized to the source frame (0–1).
			</p>
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={CROP_PARAM_KEYS}
				sectionKey="crop"
			/>
			<div className="px-4 pb-4">
				<Button type="button" variant="secondary" size="sm" onClick={resetToFullFrame}>
					Reset to full frame
				</Button>
			</div>
		</div>
	);
}
