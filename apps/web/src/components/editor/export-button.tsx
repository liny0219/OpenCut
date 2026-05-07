"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- NT server FFmpeg export bridges serialized OpenCut project JSON and media assets. */

import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

type ExportMethod = "client" | "server-ffmpeg";
const TEXT_FONT_SIZE_SCALE_REFERENCE = 90;

function getEmbeddedSessionId({ fallback }: { fallback: string }) {
	if (typeof window === "undefined") return fallback;
	const match = window.location.pathname.match(/\/editor\/([^/?#]+)/);
	return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function collectTimelineMediaIds(project: any, includeAudio: boolean) {
	const scene =
		project.scenes?.find((item: any) => item.id === project.currentSceneId) ||
		project.scenes?.find((item: any) => item.isMain) ||
		project.scenes?.[0];
	const tracks = scene?.tracks;
	const ids = new Set<string>();
	const visualElements = [
		...(tracks?.main?.elements || []),
		...(tracks?.overlay || []).flatMap((track: any) => track.elements || []),
	];
	for (const element of visualElements) {
		if ((element.type === "video" || element.type === "image") && element.mediaId) {
			ids.add(element.mediaId);
		}
	}
	if (includeAudio) {
		for (const track of tracks?.audio || []) {
			for (const element of track.elements || []) {
				if (element.type === "audio" && element.sourceType === "upload") {
					ids.add(element.mediaId);
				}
			}
		}
	}
	return ids;
}

function formatElapsed(ms: number) {
	const seconds = Math.max(0, ms / 1000);
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${(seconds - minutes * 60).toFixed(0)}s`;
}

function canvasToPngFile(canvas: HTMLCanvasElement, name: string) {
	return new Promise<File>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error("Failed to rasterize canvas"));
				return;
			}
			resolve(new File([blob], name, { type: "image/png" }));
		}, "image/png");
	});
}

function escapeSvgAttribute(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function firstCssColor(value: string) {
	return (
		value.match(/#[0-9a-f]{6,8}\b/i)?.[0] ||
		value.match(/rgba?\([^)]+\)/i)?.[0] ||
		"#000000"
	);
}

async function drawCssBackgroundToCanvas({
	canvas,
	background,
}: {
	canvas: HTMLCanvasElement;
	background: string;
}) {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available");

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;background:${escapeSvgAttribute(background)}"></div></foreignObject></svg>`;
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const image = new Image();
		image.decoding = "async";
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("Failed to render background"));
			image.src = url;
		});
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	} catch {
		ctx.fillStyle = firstCssColor(background);
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function renderBackgroundAsset(project: any) {
	const background = project.settings?.background;
	if (background?.type !== "color" || !background.color || background.color === "transparent") {
		return null;
	}
	const { width, height } = getCanvasSize(project);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	await drawCssBackgroundToCanvas({ canvas, background: background.color });
	return canvasToPngFile(canvas, "server-background.png");
}

function getCanvasSize(project: any) {
	return {
		width: Number(project.settings?.canvasSize?.width) || 1080,
		height: Number(project.settings?.canvasSize?.height) || 1920,
	};
}

function readParam(params: any, key: string, fallback: number) {
	const value = Number(params?.[key]);
	return Number.isFinite(value) ? value : fallback;
}

function estimateLayerSize({
	project,
	element,
	asset,
}: {
	project: any;
	element: any;
	asset: any;
}) {
	const { width: canvasWidth, height: canvasHeight } = getCanvasSize(project);
	const sourceWidth =
		(Number(asset?.width) || canvasWidth) *
		Math.max(0.01, readParam(element.params, "sourceCrop.width", 1));
	const sourceHeight =
		(Number(asset?.height) || canvasHeight) *
		Math.max(0.01, readParam(element.params, "sourceCrop.height", 1));
	const contain = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
	return {
		width: Math.max(
			2,
			Math.round(
				sourceWidth *
					contain *
					Math.abs(readParam(element.params, "transform.scaleX", 1)),
			),
		),
		height: Math.max(
			2,
			Math.round(
				sourceHeight *
					contain *
					Math.abs(readParam(element.params, "transform.scaleY", 1)),
			),
		),
	};
}

async function renderTextElementAsset({
	project,
	element,
}: {
	project: any;
	element: any;
}) {
	const { width, height } = getCanvasSize(project);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available");
	const params = element.params || {};
	const content = String(params.content || "").trim();
	if (!content) return null;
	const fontSize = Math.max(
		8,
		readParam(params, "fontSize", 15) *
			(height / TEXT_FONT_SIZE_SCALE_REFERENCE),
	);
	ctx.font = `${fontSize}px ${params.fontFamily || "Arial, sans-serif"}`;
	ctx.textAlign =
		params.textAlign === "left" || params.textAlign === "right"
			? params.textAlign
			: "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = params.color || "#ffffff";
	const x = width / 2 + readParam(params, "transform.positionX", 0);
	const y = height / 2 + readParam(params, "transform.positionY", 0);
	const lines = content.split("\n");
	const lineHeight = fontSize * 1.2;
	lines.forEach((line, index) => {
		ctx.fillText(line, x, y + (index - (lines.length - 1) / 2) * lineHeight);
	});
	return canvasToPngFile(canvas, `text-${element.id}.png`);
}

async function renderMaskAsset({
	project,
	element,
	asset,
}: {
	project: any;
	element: any;
	asset: any;
}) {
	const mask = element.masks?.[0];
	if (!mask || !["rectangle", "ellipse", "text"].includes(mask.type)) return null;
	const { width, height } = estimateLayerSize({ project, element, asset });
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available");
	const params = mask.params || {};
	ctx.fillStyle = params.inverted ? "#ffffff" : "#000000";
	ctx.fillRect(0, 0, width, height);
	ctx.save();
	ctx.translate(width / 2 + (Number(params.centerX) || 0) * width, height / 2 + (Number(params.centerY) || 0) * height);
	ctx.rotate(((Number(params.rotation) || 0) * Math.PI) / 180);
	ctx.scale(Number(params.scale) || 1, Number(params.scale) || 1);
	ctx.fillStyle = params.inverted ? "#000000" : "#ffffff";
	if (mask.type === "ellipse") {
		ctx.beginPath();
		ctx.ellipse(0, 0, Math.max(1, (Number(params.width) || 0.6) * width / 2), Math.max(1, (Number(params.height) || 0.6) * height / 2), 0, 0, Math.PI * 2);
		ctx.fill();
	} else if (mask.type === "rectangle") {
		ctx.fillRect(
			-((Number(params.width) || 0.6) * width) / 2,
			-((Number(params.height) || 0.6) * height) / 2,
			(Number(params.width) || 0.6) * width,
			(Number(params.height) || 0.6) * height,
		);
	} else if (mask.type === "text") {
		const fontSize = Math.max(
			8,
			(Number(params.fontSize) || 15) *
				(height / TEXT_FONT_SIZE_SCALE_REFERENCE),
		);
		ctx.font = `${fontSize}px ${params.fontFamily || "Arial, sans-serif"}`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		const lines = String(params.content || "").split("\n");
		const lineHeight = fontSize * (Number(params.lineHeight) || 1.2);
		lines.forEach((line, index) => {
			ctx.fillText(line, 0, (index - (lines.length - 1) / 2) * lineHeight);
		});
	}
	ctx.restore();
	return canvasToPngFile(canvas, `mask-${element.id}.png`);
}

async function prepareServerFfmpegProject({
	project,
	assetsById,
}: {
	project: any;
	assetsById: Map<string, any>;
}) {
	const exportProject = JSON.parse(JSON.stringify(project));
	const syntheticFiles: Array<{
		id: string;
		file: File;
		type: "image";
		width: number;
		height: number;
		purpose?: "media" | "mask" | "background";
	}> = [];
	const backgroundFile = await renderBackgroundAsset(exportProject);
	if (backgroundFile) {
		const { width, height } = getCanvasSize(exportProject);
		syntheticFiles.push({
			id: "server-background",
			file: backgroundFile,
			type: "image",
			width,
			height,
			purpose: "background",
		});
	}
	const scene =
		exportProject.scenes?.find((item: any) => item.id === exportProject.currentSceneId) ||
		exportProject.scenes?.find((item: any) => item.isMain) ||
		exportProject.scenes?.[0];
	if (!scene?.tracks) return { exportProject, syntheticFiles };

	for (const track of [scene.tracks.main, ...(scene.tracks.overlay || [])]) {
		if (!track?.elements) continue;
		const nextElements: any[] = [];
		for (const element of track.elements) {
			if (element.type === "text") {
				const textFile = await renderTextElementAsset({ project: exportProject, element });
				if (textFile) {
					const { width, height } = getCanvasSize(exportProject);
					const syntheticId = `server-text-${element.id}`;
					syntheticFiles.push({ id: syntheticId, file: textFile, type: "image", width, height });
					nextElements.push({
						...element,
						type: "image",
						mediaId: syntheticId,
						params: {
							...element.params,
							"transform.positionX": 0,
							"transform.positionY": 0,
							"transform.scaleX": 1,
							"transform.scaleY": 1,
							"sourceCrop.x": 0,
							"sourceCrop.y": 0,
							"sourceCrop.width": 1,
							"sourceCrop.height": 1,
						},
					});
				}
				continue;
			}
			if ((element.type === "video" || element.type === "image") && element.masks?.length) {
				const asset = assetsById.get(element.mediaId);
				const maskFile = asset ? await renderMaskAsset({ project: exportProject, element, asset }) : null;
				if (maskFile) {
					const size = estimateLayerSize({ project: exportProject, element, asset });
					const maskId = `server-mask-${element.id}`;
					syntheticFiles.push({ id: maskId, file: maskFile, type: "image", ...size, purpose: "mask" });
					nextElements.push({
						...element,
						params: { ...element.params, __serverMaskMediaId: maskId },
					});
					continue;
				}
			}
			nextElements.push(element);
		}
		track.elements = nextElements;
	}
	return { exportProject, syntheticFiles };
}

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover />}
		</Popover>
	);
}

function ExportPopover() {
	const editor = useEditor();
	const searchParams = useSearchParams();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const parentOrigin = searchParams.get("parentOrigin");
	const isEmbeddedInNt = searchParams.get("embed") === "1" && !!parentOrigin;
	const defaultExportMethod = isEmbeddedInNt ? "server-ffmpeg" : "client";
	const [lastError, setLastError] = useState<string | null>(null);
	const [exportMethod, setExportMethod] =
		useState<ExportMethod>(defaultExportMethod);
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [serverExportState, setServerExportState] = useState<{
		isExporting: boolean;
		message: string;
		progress: number;
		timing?: string;
	}>({ isExporting: false, message: "", progress: 0 });
	const [lastTiming, setLastTiming] = useState<string | null>(null);
	const [clientExportElapsedMs, setClientExportElapsedMs] = useState(0);
	const serverAbortController = useRef<{ abort: () => void } | null>(null);
	const serverJobRef = useRef<{ endpoint: string; jobId: string } | null>(null);
	const clientExportTimerRef = useRef<ReturnType<typeof setInterval> | null>(
		null,
	);
	const isBusy = isExporting || serverExportState.isExporting;

	const clearClientExportTimer = useCallback(() => {
		if (!clientExportTimerRef.current) return;
		clearInterval(clientExportTimerRef.current);
		clientExportTimerRef.current = null;
	}, []);

	const serverExportEndpoint = useMemo(() => {
		if (!parentOrigin) return null;
		const sessionId = getEmbeddedSessionId({ fallback: activeProject.metadata.id });
		return `${parentOrigin}/api/opencut/sessions/${encodeURIComponent(
			sessionId,
		)}/exports/ffmpeg`;
	}, [activeProject.metadata.id, parentOrigin]);

	const startServerExport = useCallback(async () => {
		if (!activeProject || !serverExportEndpoint || serverExportState.isExporting) {
			return;
		}
			setLastError(null);
			setClientExportElapsedMs(0);
				setServerExportState({
				isExporting: true,
				message: "Preparing files for FFmpeg",
				progress: 2,
			});
		const abortController = new AbortController();
		serverAbortController.current = abortController;

		try {
			await editor.save.flush();
			setLastTiming(null);
			const requiredIds = collectTimelineMediaIds(
				activeProject,
				shouldIncludeAudio,
			);
			const assets = editor.media.getAssets();
			const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
			const missing = [...requiredIds].filter((id) => {
				const asset = assetsById.get(id);
				return !asset || !asset.file || asset.file.size <= 0;
			});
			if (missing.length > 0) {
				throw new Error(
					"Some timeline media is still remote. Load it into the OpenCut library before exporting with FFmpeg.",
				);
			}

				const prepared = await prepareServerFfmpegProject({
					project: activeProject,
					assetsById,
				});
				const formData = new FormData();
				const mediaManifest: Array<Record<string, unknown>> = [];
				for (const id of requiredIds) {
				const asset = assetsById.get(id);
				if (!asset) continue;
				const fieldName = `media-${asset.id}`;
				formData.append(fieldName, asset.file, asset.name || asset.file.name);
					mediaManifest.push({
					id: asset.id,
					fieldName,
					name: asset.name || asset.file.name,
					type: asset.type,
					width: asset.width,
					height: asset.height,
					duration: asset.duration,
					hasAudio: asset.hasAudio,
						mime: asset.file.type,
					});
				}
				for (const item of prepared.syntheticFiles) {
					const fieldName = `media-${item.id}`;
					formData.append(fieldName, item.file, item.file.name);
					mediaManifest.push({
						id: item.id,
						fieldName,
						name: item.file.name,
						type: item.type,
						width: item.width,
						height: item.height,
						duration: undefined,
						hasAudio: false,
						mime: item.file.type,
						purpose: item.purpose || "media",
					});
				}

				formData.append("projectJson", JSON.stringify(prepared.exportProject));
				formData.append("mediaManifest", JSON.stringify(mediaManifest));
				formData.append("includeAudio", String(shouldIncludeAudio));
				formData.append(
					"fileName",
					`${activeProject.metadata.name || "opencut-export"}.mp4`,
				);

				const totalStartedAt = performance.now();
				let uploadDoneAt = totalStartedAt;
				const jobResponse = await new Promise<any>((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					serverAbortController.current = { abort: () => xhr.abort() };
					xhr.open("POST", `${serverExportEndpoint}/jobs`);
					xhr.responseType = "json";
					xhr.upload.onprogress = (event) => {
						if (!event.lengthComputable) return;
						const uploadProgress = Math.round((event.loaded / event.total) * 25);
						setServerExportState({
							isExporting: true,
							message: "Uploading files to FFmpeg",
							progress: Math.max(2, uploadProgress),
						});
					};
					xhr.onload = () => {
						uploadDoneAt = performance.now();
						if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
						else reject(new Error(xhr.response?.error || `Server FFmpeg export failed (${xhr.status})`));
					};
					xhr.onerror = () => reject(new Error("Server FFmpeg upload failed"));
					xhr.onabort = () => reject(new DOMException("Server FFmpeg export cancelled", "AbortError"));
					xhr.send(formData);
				});
				const job = jobResponse?.data?.job;
				if (!job?.id) throw new Error("Server FFmpeg did not return a job id");
				serverJobRef.current = { endpoint: serverExportEndpoint, jobId: job.id };

				let completedJob = job;
				while (true) {
					if (abortController.signal.aborted) throw new DOMException("Server FFmpeg export cancelled", "AbortError");
					const statusResponse = await fetch(`${serverExportEndpoint}/jobs/${job.id}`, {
						signal: abortController.signal,
					});
					const statusJson = await statusResponse.json();
					completedJob = statusJson?.data?.job;
					const renderProgress = Number(completedJob?.progress || 0);
					const totalProgress = Math.min(99, 25 + Math.round(renderProgress * 0.74));
					setServerExportState({
						isExporting: true,
						message: completedJob?.status === "queued" ? "Waiting for FFmpeg" : "FFmpeg is rendering on the server",
						progress: totalProgress,
						timing: `Upload ${formatElapsed(uploadDoneAt - totalStartedAt)} · render ${formatElapsed(performance.now() - uploadDoneAt)}`,
					});
					if (completedJob?.status === "completed") break;
					if (completedJob?.status === "failed" || completedJob?.status === "cancelled") {
						throw new Error(completedJob.error || "Server FFmpeg export failed");
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}

				const downloadResponse = await fetch(`${serverExportEndpoint}/jobs/${job.id}/download`, {
					signal: abortController.signal,
				});
				if (!downloadResponse.ok) throw new Error("Server FFmpeg download failed");
				const blob = await downloadResponse.blob();
				downloadBlob({
					blob,
					filename: `${activeProject.metadata.name || "opencut-export"}.mp4`,
				});
				const totalDoneAt = performance.now();
				const timing = `Server FFmpeg: upload ${formatElapsed(uploadDoneAt - totalStartedAt)}, render ${formatElapsed(totalDoneAt - uploadDoneAt)}, total ${formatElapsed(totalDoneAt - totalStartedAt)}`;
				setLastTiming(timing);
				console.info(`[OpenCut] ${timing}`);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				setLastError("Server FFmpeg export cancelled");
			} else {
				const message =
					error instanceof Error ? error.message : "Server FFmpeg export failed";
				setLastError(message);
				console.error("[OpenCut] Server FFmpeg export failed", error);
			}
		} finally {
			serverAbortController.current = null;
			serverJobRef.current = null;
			setServerExportState({ isExporting: false, message: "", progress: 0 });
		}
	}, [
		activeProject,
		editor,
		serverExportEndpoint,
		serverExportState.isExporting,
		shouldIncludeAudio,
	]);

	const startExport = useCallback(async () => {
		if (!activeProject || isBusy) return;
		if (exportMethod === "server-ffmpeg") {
			await startServerExport();
			return;
		}
		setLastError(null);
		setLastTiming(null);
		const startedAt = performance.now();
		setClientExportElapsedMs(0);
		clearClientExportTimer();
		clientExportTimerRef.current = setInterval(() => {
			setClientExportElapsedMs(performance.now() - startedAt);
		}, 500);
		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.cancelled) {
			clearClientExportTimer();
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.buffer) {
			downloadBuffer({
				buffer: result.buffer,
				filename: `${activeProject.metadata.name}${getExportFileExtension({
					format,
				})}`,
				mimeType: getExportMimeType({ format }),
			});
			editor.project.clearExportState();
			const timing = `Client export: total ${formatElapsed(performance.now() - startedAt)}`;
			setLastTiming(timing);
			console.info(`[OpenCut] ${timing}`);
			clearClientExportTimer();
			return;
		}

		const message = result.success
			? "Export did not return a file"
			: result.error || "Export failed";
		setLastError(message);
		clearClientExportTimer();
		console.error("[OpenCut] Export failed", {
			projectId: activeProject.metadata.id,
			projectName: activeProject.metadata.name,
			format,
			quality,
			includeAudio: shouldIncludeAudio,
			message,
		});
	}, [
		activeProject,
		editor,
		format,
		isBusy,
		exportMethod,
		quality,
		shouldIncludeAudio,
		startServerExport,
		clearClientExportTimer,
	]);

	const handleCancel = () => {
		if (serverExportState.isExporting) {
			const job = serverJobRef.current;
			if (job) {
				fetch(`${job.endpoint}/jobs/${job.jobId}`, { method: "DELETE" }).catch(
					() => {},
				);
			}
			serverAbortController.current?.abort();
			return;
		}
		if (isExporting) {
			clearClientExportTimer();
			editor.project.cancelExport();
		}
	};

	return (
		<>
			{isBusy && (
				<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm">
					<div className="bg-background w-[min(24rem,calc(100vw-2rem))] rounded-lg border p-5 shadow-xl">
						<div className="mb-4 flex items-start justify-between gap-4">
							<div>
								<p className="text-sm font-medium">Exporting video</p>
								<p className="text-muted-foreground mt-1 text-xs">
									{serverExportState.isExporting
										? serverExportState.message
										: "Please wait for this export to finish before editing."}
								</p>
									{serverExportState.timing ? (
										<p className="text-muted-foreground mt-1 text-xs">
											{serverExportState.timing}
										</p>
									) : isExporting ? (
										<p className="text-muted-foreground mt-1 text-xs">
											Elapsed {formatElapsed(clientExportElapsedMs)}
										</p>
									) : null}
							</div>
							<p className="text-muted-foreground text-sm">
								{serverExportState.isExporting
									? `${Math.round(serverExportState.progress)}%`
									: `${Math.round(progress * 100)}%`}
							</p>
						</div>
						<Progress
							value={
								serverExportState.isExporting
									? serverExportState.progress
									: progress * 100
							}
							className="mb-4 w-full"
						/>
						<Button
							variant="outline"
							className="w-full rounded-md"
							onClick={handleCancel}
						>
							Cancel export
						</Button>
					</div>
				</div>
			)}
			<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{(exportResult && !exportResult.success) || lastError ? (
				<ExportError
					error={
						lastError ||
						exportResult?.error ||
						"Unknown error occurred"
					}
					onRetry={startExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						<div className="flex flex-col">
							{lastTiming ? (
								<div className="text-muted-foreground border-b px-3 py-2 text-xs">
									{lastTiming}
								</div>
							) : null}
							<Section
								collapsible
								defaultOpen
								showTopBorder={false}
							>
								<SectionHeader>
									<SectionTitle>Export method</SectionTitle>
								</SectionHeader>
								<SectionContent>
									<RadioGroup
										value={exportMethod}
										onValueChange={(value) => {
											if (value === "client" || value === "server-ffmpeg") {
												setExportMethod(value);
											}
										}}
									>
										<div className="flex items-start space-x-2">
											<RadioGroupItem value="client" id="export-client" />
											<Label htmlFor="export-client" className="leading-5">
												Client export
												<span className="text-muted-foreground block text-xs font-normal">
													Uses the browser renderer.
												</span>
											</Label>
										</div>
										<div className="flex items-start space-x-2">
											<RadioGroupItem
												value="server-ffmpeg"
												id="export-server-ffmpeg"
												disabled={!isEmbeddedInNt}
											/>
											<Label
												htmlFor="export-server-ffmpeg"
												className={cn(
													"leading-5",
													!isEmbeddedInNt && "opacity-50",
												)}
											>
												Server FFmpeg
												<span className="text-muted-foreground block text-xs font-normal">
													Uses NT backend FFmpeg and downloads the result.
												</span>
											</Label>
										</div>
									</RadioGroup>
								</SectionContent>
							</Section>

							<Section
								collapsible
								defaultOpen={false}
							>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
							</Section>

							<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
							</Section>

							<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
							</Section>
						</div>

						<div className="p-3 pt-0">
							<Button
								onClick={startExport}
								className="w-full gap-2"
								disabled={isBusy || (exportMethod === "server-ffmpeg" && !isEmbeddedInNt)}
							>
								<Download className="size-4" />
								{exportMethod === "server-ffmpeg"
									? "Export with FFmpeg"
									: "Export in browser"}
							</Button>
						</div>
					</div>
				</>
			)}
			</PopoverContent>
		</>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
