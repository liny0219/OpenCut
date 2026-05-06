"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { generateUUID } from "@/utils/id";

/** NT iframe：与 nt-embed-bridge 的 parentOrigin 一致 */
function getNtEmbedParentTarget(): string | null {
	if (typeof window === "undefined") return null;
	const sp = new URLSearchParams(window.location.search);
	if (sp.get("embed") !== "1") return null;
	const raw = sp.get("parentOrigin");
	return raw && raw.length > 0 ? raw : "*";
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
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [queue, setQueue] = useState<ExportQueueItem[]>([]);
	const isProcessingRef = useRef(false);
	const currentJobIdRef = useRef<string | null>(null);
	const currentUploadAbortRef = useRef<AbortController | null>(null);
	const [currentJobId, setCurrentJobId] = useState<string | null>(null);

	const enqueueExport = () => {
		if (!activeProject) return;
		const item: ExportQueueItem = {
			id: generateUUID(),
			projectName: activeProject.metadata.name,
			format,
			quality,
			includeAudio: shouldIncludeAudio,
			status: "queued",
			progress: 0,
			createdAt: Date.now(),
		};
		setQueue((items) => [...items, item]);
	};

	const runExportJob = useCallback(async (job: ExportQueueItem) => {
		if (!activeProject) return;
		currentJobIdRef.current = job.id;
		setCurrentJobId(job.id);
		setQueue((items) =>
			items.map((item) =>
				item.id === job.id ? { ...item, status: "running", progress: 0 } : item,
			),
		);
		const result = await editor.project.export({
			options: {
				format: job.format,
				quality: job.quality,
				fps: activeProject.settings.fps,
				includeAudio: job.includeAudio,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			setQueue((items) =>
				items.map((item) =>
					item.id === job.id ? { ...item, status: "cancelled" } : item,
				),
			);
			return;
		}

		if (result.success && result.buffer) {
			const filename = `${activeProject.metadata.name}${getExportFileExtension({ format: job.format })}`;
			const mimeType = getExportMimeType({ format: job.format });
			const parentTarget = getNtEmbedParentTarget();

			if (parentTarget != null && window.parent !== window) {
				const transferable = result.buffer.slice(0);
				setQueue((items) =>
					items.map((item) =>
						item.id === job.id
							? { ...item, status: "uploading", progress: 1, filename }
							: item,
					),
				);
				const uploadAbortController = new AbortController();
				currentUploadAbortRef.current = uploadAbortController;
				try {
					await postExportToNtAndWait({
						exportId: job.id,
						parentTarget,
						sessionId: activeProject.metadata.id,
						fileName: filename,
						mimeType,
						buffer: transferable,
						signal: uploadAbortController.signal,
					});
				} catch (err) {
					if (isAbortError(err)) {
						editor.project.clearExportState();
						setQueue((items) =>
							items.map((item) =>
								item.id === job.id ? { ...item, status: "cancelled" } : item,
							),
						);
						return;
					}
					throw err;
				} finally {
					currentUploadAbortRef.current = null;
				}
			} else {
				downloadBuffer({
					buffer: result.buffer,
					filename,
					mimeType,
				});
			}

			editor.project.clearExportState();
			setQueue((items) =>
				items.map((item) =>
					item.id === job.id
						? { ...item, status: "completed", progress: 1, filename }
						: item,
				),
			);
			return;
		}

		setQueue((items) =>
			items.map((item) =>
				item.id === job.id
					? {
							...item,
							status: "failed",
							error: result.success ? "Export did not return a file" : result.error,
						}
					: item,
			),
		);
	}, [activeProject, editor]);

	useEffect(() => {
		if (isProcessingRef.current) return;
		const nextJob = queue.find((item) => item.status === "queued");
		if (!nextJob) return;

		isProcessingRef.current = true;
		void runExportJob(nextJob)
			.catch((err) => {
				setQueue((items) =>
					items.map((item) =>
						item.id === nextJob.id
							? {
									...item,
									status: "failed",
									error: err instanceof Error ? err.message : "Export failed",
								}
							: item,
					),
				);
			})
			.finally(() => {
				currentJobIdRef.current = null;
				setCurrentJobId(null);
				isProcessingRef.current = false;
				setQueue((items) => [...items]);
			});
	}, [queue, runExportJob]);

	const handleCancel = (jobId: string) => {
		if (currentJobIdRef.current !== jobId) {
			setQueue((items) =>
				items.map((item) =>
					item.id === jobId && item.status === "queued"
						? { ...item, status: "cancelled" }
						: item,
				),
			);
			return;
		}
		const currentItem = queue.find((item) => item.id === jobId);
		if (currentItem?.status === "uploading") {
			currentUploadAbortRef.current?.abort();
			return;
		}
		editor.project.cancelExport();
	};

	const clearFinished = () => {
		setQueue((items) =>
			items.filter(
				(item) =>
					item.status === "queued" ||
					item.status === "running" ||
					item.status === "uploading",
			),
		);
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={enqueueExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
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
									<Button onClick={enqueueExport} className="w-full gap-2">
										<Download className="size-4" />
										Add to export queue
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={() => {
										const currentId = currentJobIdRef.current;
										if (currentId) handleCancel(currentId);
									}}
								>
									Cancel running export
								</Button>
							</div>
						)}

						<ExportQueue
							items={queue}
							progress={progress}
							currentJobId={currentJobId}
							onCancel={handleCancel}
							onClearFinished={clearFinished}
						/>
					</div>
				</>
			)}
		</PopoverContent>
	);
}

type ExportQueueItem = {
	id: string;
	projectName: string;
	format: ExportFormat;
	quality: ExportQuality;
	includeAudio: boolean;
	status: "queued" | "running" | "uploading" | "completed" | "cancelled" | "failed";
	progress: number;
	createdAt: number;
	filename?: string;
	error?: string;
};

function isAbortError(value: unknown) {
	return value instanceof DOMException && value.name === "AbortError";
}

function postExportToNtAndWait({
	exportId,
	parentTarget,
	sessionId,
	fileName,
	mimeType,
	buffer,
	signal,
}: {
	exportId: string;
	parentTarget: string;
	sessionId: string;
	fileName: string;
	mimeType: string;
	buffer: ArrayBuffer;
	signal?: AbortSignal;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Export upload cancelled", "AbortError"));
			return;
		}

		const timeout = window.setTimeout(() => {
			window.removeEventListener("message", onMessage);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Timed out waiting for NT export confirmation"));
		}, 10 * 60 * 1000);

		const cleanup = () => {
			window.clearTimeout(timeout);
			window.removeEventListener("message", onMessage);
			signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			cleanup();
			window.parent.postMessage(
				{
					type: "OPENCUT_EXPORT_CANCEL",
					source: "opencut",
					exportId,
					sessionId,
				},
				parentTarget,
			);
			reject(new DOMException("Export upload cancelled", "AbortError"));
		};

		const onMessage = (event: MessageEvent) => {
			if (parentTarget !== "*" && event.origin !== parentTarget) return;
			if (event.data?.source !== "nt" || event.data?.exportId !== exportId) return;
			if (event.data?.type === "NT_OPENCUT_EXPORT_COMPLETE") {
				cleanup();
				resolve();
			}
			if (event.data?.type === "NT_OPENCUT_EXPORT_CANCELLED") {
				cleanup();
				reject(new DOMException("Export upload cancelled", "AbortError"));
			}
			if (event.data?.type === "NT_OPENCUT_EXPORT_FAILED") {
				cleanup();
				reject(new Error(event.data?.message || "NT export sync failed"));
			}
		};

		window.addEventListener("message", onMessage);
		signal?.addEventListener("abort", onAbort, { once: true });
		window.parent.postMessage(
			{
				type: "OPENCUT_EXPORT_BLOB",
				source: "opencut",
				exportId,
				sessionId,
				fileName,
				mimeType,
				byteSize: buffer.byteLength,
				buffer,
			},
			parentTarget,
			[buffer],
		);
	});
}

function ExportQueue({
	items,
	progress,
	currentJobId,
	onCancel,
	onClearFinished,
}: {
	items: ExportQueueItem[];
	progress: number;
	currentJobId: string | null;
	onCancel: (jobId: string) => void;
	onClearFinished: () => void;
}) {
	if (items.length === 0) return null;

	return (
		<div className="border-t p-3 space-y-2">
			<div className="flex items-center justify-between">
				<p className="text-sm font-medium">Export queue</p>
				<Button variant="text" size="sm" onClick={onClearFinished}>
					Clear finished
				</Button>
			</div>
			<div className="space-y-2">
				{items.map((item) => {
					const isCurrent = item.id === currentJobId;
					const shownProgress = isCurrent ? progress : item.progress;
					return (
						<div key={item.id} className="rounded-md border p-2 space-y-2">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<p className="truncate text-xs font-medium">
										{item.filename || `${item.projectName}.${item.format}`}
									</p>
									<p className="text-muted-foreground text-[11px]">
										{exportStatusLabel(item.status)}
									</p>
								</div>
								{(item.status === "queued" ||
									item.status === "running" ||
									item.status === "uploading") && (
									<Button
										variant="outline"
										size="sm"
										className="h-7 px-2 text-xs"
										onClick={() => onCancel(item.id)}
									>
										{item.status === "uploading" ? "Interrupt" : "Cancel"}
									</Button>
								)}
							</div>
							{(item.status === "running" || item.status === "uploading") && (
								<Progress value={shownProgress * 100} className="h-1.5 w-full" />
							)}
							{item.error && (
								<p className="text-destructive text-[11px]">{item.error}</p>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function exportStatusLabel(status: ExportQueueItem["status"]) {
	switch (status) {
		case "queued":
			return "Waiting";
		case "running":
			return "Compositing";
		case "uploading":
			return "Syncing to NT outputs";
		case "completed":
			return "Synced to NT outputs";
		case "cancelled":
			return "Cancelled";
		case "failed":
			return "Failed";
	}
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
