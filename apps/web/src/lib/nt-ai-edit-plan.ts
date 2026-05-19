"use client";

import type { EditorCore } from "@/core";
import { AddTrackCommand, InsertElementCommand } from "@/commands/timeline";
import type {
	CreateTimelineElement,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "@/timeline";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds, mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";

type AiTrackType = "video" | "audio" | "text";
type AiMediaType = "video" | "audio" | "image";

export type NtAiEditAction =
	| { type: "add_track"; trackType: AiTrackType }
	| {
			type: "insert_media";
			mediaId: string;
			mediaType?: AiMediaType;
			trackType?: AiTrackType;
			trackId?: string;
			startSec: number;
			durationSec?: number;
			trimStartSec?: number;
			trimEndSec?: number;
	  }
	| {
			type: "insert_text";
			text: string;
			startSec: number;
			durationSec: number;
			stylePreset?: "title" | "subtitle" | "cta";
			trackId?: string;
	  }
	| {
			type: "trim_element";
			elementId: string;
			startSec?: number;
			durationSec?: number;
			trimStartSec?: number;
			trimEndSec?: number;
	  }
	| {
			type: "move_element";
			elementId: string;
			targetTrackId?: string;
			startSec: number;
	  }
	| { type: "delete_element"; elementId: string }
	| { type: "set_volume"; elementId: string; volume: number };

export type NtAiEditPlan = {
	summary?: string;
	actions: NtAiEditAction[];
};

export type NtAiEditContext = {
	sessionId: string;
	mediaAssets: Array<{
		id: string;
		name: string;
		type: string;
		duration?: number;
		width?: number;
		height?: number;
		hasAudio?: boolean;
		source?: string;
	}>;
	tracks: Array<{
		id: string;
		type: string;
		name: string;
		elements: string[];
	}>;
	elements: Array<{
		id: string;
		trackId: string;
		type: string;
		name: string;
		mediaId?: string;
		startTime: number;
		duration: number;
		trimStart: number;
		trimEnd: number;
		text?: string;
	}>;
	projectSettings: {
		width: number;
		height: number;
		fps: unknown;
	};
};

export class NtAiEditPlanError extends Error {
	// eslint-disable-next-line opencut/prefer-object-params
	constructor(
		message: string,
		public readonly failedActionIndex?: number,
	) {
		super(message);
		this.name = "NtAiEditPlanError";
	}
}

export function buildNtAiEditContext({
	editor,
	sessionId,
}: {
	editor: EditorCore;
	sessionId: string;
}): NtAiEditContext {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveSceneOrNull();
	const tracks = scene?.tracks;
	const allTracks = tracks ? flattenTracks(tracks) : [];

	return {
		sessionId,
		mediaAssets: editor.media.getAssets().map((asset) => ({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			duration: asset.duration,
			width: asset.width,
			height: asset.height,
			hasAudio: asset.hasAudio,
			source: asset.remoteUrl ? "remote" : asset.url ? "local" : undefined,
		})),
		tracks: allTracks.map((track) => ({
			id: track.id,
			type: track.type,
			name: track.name,
			elements: track.elements.map((element) => element.id),
		})),
		elements: allTracks.flatMap((track) =>
			track.elements.map((element) => ({
				id: element.id,
				trackId: track.id,
				type: element.type,
				name: element.name,
				mediaId: "mediaId" in element ? element.mediaId : undefined,
				startTime: mediaTimeToSeconds({ time: element.startTime }),
				duration: mediaTimeToSeconds({ time: element.duration }),
				trimStart: mediaTimeToSeconds({ time: element.trimStart }),
				trimEnd: mediaTimeToSeconds({ time: element.trimEnd }),
				text:
					element.type === "text" && typeof element.params.content === "string"
						? element.params.content
						: undefined,
			})),
		),
		projectSettings: {
			width: project?.settings.canvasSize.width ?? 1920,
			height: project?.settings.canvasSize.height ?? 1080,
			fps: project?.settings.fps ?? null,
		},
	};
}

export async function applyNtAiEditPlan({
	editor,
	editPlan,
}: {
	editor: EditorCore;
	editPlan: unknown;
}): Promise<{ summary: string; appliedActions: string[] }> {
	const plan = validateEditPlan(editPlan);
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) {
		throw new NtAiEditPlanError("No active OpenCut scene");
	}

	const beforeTracks = scene.tracks;
	const appliedActions: string[] = [];

	try {
		for (const [index, action] of plan.actions.entries()) {
			appliedActions.push(applyAction({ editor, action, index }));
		}
		await editor.save.flush();
		return {
			summary: plan.summary || `Applied ${appliedActions.length} AI edit actions`,
			appliedActions,
		};
	} catch (error) {
		editor.timeline.updateTracks(beforeTracks);
		if (error instanceof NtAiEditPlanError) {
			throw error;
		}
		throw new NtAiEditPlanError(
			error instanceof Error ? error.message : "Failed to apply AI edit plan",
			appliedActions.length,
		);
	}
}

function applyAction({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: NtAiEditAction;
	index: number;
}): string {
	switch (action.type) {
		case "add_track": {
			const trackType = validateTrackType(action.trackType, index);
			const command = new AddTrackCommand({ type: trackType });
			editor.command.execute({ command });
			return `Added ${trackType} track`;
		}
		case "insert_media":
			return insertMedia({ editor, action, index });
		case "insert_text":
			return insertText({ editor, action, index });
		case "trim_element":
			return trimElement({ editor, action, index });
		case "move_element":
			return moveElement({ editor, action, index });
		case "delete_element":
			return deleteElement({ editor, action, index });
		case "set_volume":
			return setVolume({ editor, action, index });
	}
}

function insertMedia({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "insert_media" }>;
	index: number;
}): string {
	const asset = editor.media.getAssets().find((item) => item.id === action.mediaId);
	if (!asset) {
		throw new NtAiEditPlanError(`Media asset not found: ${action.mediaId}`, index);
	}
	const mediaType = action.mediaType ?? asset.type;
	if (mediaType !== asset.type) {
		throw new NtAiEditPlanError(`Media type mismatch for asset ${asset.id}`, index);
	}

	const trimStart = seconds(action.trimStartSec ?? 0, "trimStartSec", index);
	const trimEnd = seconds(action.trimEndSec ?? 0, "trimEndSec", index);
	const sourceDurationSec = action.durationSec ?? asset.duration ?? 5;
	const durationSec = Math.max(0.01, sourceDurationSec - (action.trimStartSec ?? 0) - (action.trimEndSec ?? 0));
	const element: CreateTimelineElement = {
		...buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration: seconds(durationSec, "durationSec", index),
			startTime: seconds(action.startSec, "startSec", index),
		}),
		trimStart,
		trimEnd,
	};

	const trackType = action.trackType ?? (asset.type === "audio" ? "audio" : "video");
	const command = new InsertElementCommand({
		element,
		placement: action.trackId
			? { mode: "explicit", trackId: action.trackId }
			: { mode: "auto", trackType },
	});
	editor.command.execute({ command });
	return `Inserted ${asset.name}`;
}

function insertText({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "insert_text" }>;
	index: number;
}): string {
	const text = action.text.trim();
	if (!text) {
		throw new NtAiEditPlanError("insert_text.text is required", index);
	}
	const preset = action.stylePreset ?? "subtitle";
	const fontSize = preset === "title" ? 44 : preset === "cta" ? 36 : 24;
	const element = buildTextElement({
		startTime: seconds(action.startSec, "startSec", index),
		raw: {
			name: preset === "title" ? "AI Title" : preset === "cta" ? "AI CTA" : "AI Subtitle",
			duration: seconds(action.durationSec, "durationSec", index),
			params: {
				content: text,
				fontSize,
				"transform.positionY": preset === "title" ? -280 : preset === "cta" ? 260 : 320,
				"background.enabled": preset !== "title",
				"background.color": "#000000",
			},
		},
	});
	const command = new InsertElementCommand({
		element,
		placement: action.trackId
			? { mode: "explicit", trackId: action.trackId }
			: { mode: "auto", trackType: "text" },
	});
	editor.command.execute({ command });
	return `Inserted text: ${text.slice(0, 24)}`;
}

function trimElement({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "trim_element" }>;
	index: number;
}): string {
	const ref = findElementRef(editor, action.elementId);
	if (!ref) {
		throw new NtAiEditPlanError(`Element not found: ${action.elementId}`, index);
	}
	const patch: Partial<TimelineElement> = {};
	if (action.startSec !== undefined) patch.startTime = seconds(action.startSec, "startSec", index);
	if (action.durationSec !== undefined) patch.duration = seconds(action.durationSec, "durationSec", index);
	if (action.trimStartSec !== undefined) patch.trimStart = seconds(action.trimStartSec, "trimStartSec", index);
	if (action.trimEndSec !== undefined) patch.trimEnd = seconds(action.trimEndSec, "trimEndSec", index);
	editor.timeline.updateElements({
		updates: [{ trackId: ref.track.id, elementId: ref.element.id, patch }],
	});
	return `Trimmed ${ref.element.name}`;
}

function moveElement({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "move_element" }>;
	index: number;
}): string {
	const ref = findElementRef(editor, action.elementId);
	if (!ref) {
		throw new NtAiEditPlanError(`Element not found: ${action.elementId}`, index);
	}
	const targetTrackId = action.targetTrackId ?? ref.track.id;
	if (!editor.timeline.getTrackById({ trackId: targetTrackId })) {
		throw new NtAiEditPlanError(`Target track not found: ${targetTrackId}`, index);
	}
	editor.timeline.moveElements({
		moves: [{
			sourceTrackId: ref.track.id,
			targetTrackId,
			elementId: ref.element.id,
			newStartTime: seconds(action.startSec, "startSec", index),
		}],
	});
	return `Moved ${ref.element.name}`;
}

function deleteElement({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "delete_element" }>;
	index: number;
}): string {
	const ref = findElementRef(editor, action.elementId);
	if (!ref) {
		throw new NtAiEditPlanError(`Element not found: ${action.elementId}`, index);
	}
	editor.timeline.deleteElements({
		elements: [{ trackId: ref.track.id, elementId: ref.element.id }],
	});
	return `Deleted ${ref.element.name}`;
}

function setVolume({
	editor,
	action,
	index,
}: {
	editor: EditorCore;
	action: Extract<NtAiEditAction, { type: "set_volume" }>;
	index: number;
}): string {
	const ref = findElementRef(editor, action.elementId);
	if (!ref) {
		throw new NtAiEditPlanError(`Element not found: ${action.elementId}`, index);
	}
	if (ref.element.type !== "audio" && ref.element.type !== "video") {
		throw new NtAiEditPlanError("set_volume only supports audio or video elements", index);
	}
	const db = action.volume >= 0 && action.volume <= 1
		? action.volume === 0 ? -60 : 20 * Math.log10(action.volume)
		: action.volume;
	editor.timeline.updateElements({
		updates: [{
			trackId: ref.track.id,
			elementId: ref.element.id,
			patch: { params: { ...ref.element.params, volume: clamp(db, -60, 20) } },
		}],
	});
	return `Set volume for ${ref.element.name}`;
}

function validateEditPlan(value: unknown): NtAiEditPlan {
	if (typeof value !== "object" || value === null) {
		throw new NtAiEditPlanError("AI edit plan must be an object");
	}
	const plan = value as Partial<NtAiEditPlan>;
	if (!Array.isArray(plan.actions)) {
		throw new NtAiEditPlanError("AI edit plan actions must be an array");
	}
	if (plan.actions.length > 40) {
		throw new NtAiEditPlanError("AI edit plan is too large");
	}
	for (const [index, action] of plan.actions.entries()) {
		if (typeof action !== "object" || action === null || typeof (action as { type?: unknown }).type !== "string") {
			throw new NtAiEditPlanError("Each AI edit action needs a type", index);
		}
	}
	return {
		summary: typeof plan.summary === "string" ? plan.summary : undefined,
		actions: plan.actions as NtAiEditAction[],
	};
}

// eslint-disable-next-line opencut/prefer-object-params
function validateTrackType(trackType: unknown, index: number): TrackType {
	if (trackType === "video" || trackType === "audio" || trackType === "text") {
		return trackType;
	}
	throw new NtAiEditPlanError(`Unsupported track type: ${String(trackType)}`, index);
}

// eslint-disable-next-line opencut/prefer-object-params
function seconds(value: number, field: string, index: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new NtAiEditPlanError(`${field} must be a non-negative number`, index);
	}
	return value === 0 ? ZERO_MEDIA_TIME : mediaTimeFromSeconds({ seconds: value });
}

// eslint-disable-next-line opencut/prefer-object-params
function findElementRef(editor: EditorCore, elementId: string): { track: TimelineTrack; element: TimelineElement } | null {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return null;
	for (const track of flattenTracks(scene.tracks)) {
		const element = track.elements.find((item) => item.id === elementId);
		if (element) return { track, element };
	}
	return null;
}

function flattenTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

// eslint-disable-next-line opencut/prefer-object-params
function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}
