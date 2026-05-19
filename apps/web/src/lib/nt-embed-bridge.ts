"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import {
	applyNtAiEditPlan,
	buildNtAiEditContext,
	NtAiEditPlanError,
} from "./nt-ai-edit-plan";

type SerializedProject = import("@/services/storage/types").SerializedProject;

type NtOpenCutAsset = {
	assetId: string;
	fileName: string;
	typeCode: "VIDEO" | "AUDIO";
	mime?: string | null;
	byteSize?: number | null;
	duration?: number | null;
	downloadUrl: string;
	languageCode?: string | null;
	role?: string | null;
	source?: string | null;
};

function getAssetSyncWeight(asset: NtOpenCutAsset): number {
	const mediaWeight = asset.typeCode === "AUDIO" ? 0 : 1;
	return mediaWeight * 1_000_000_000_000 + (asset.byteSize ?? 0);
}

type NtLoadProjectMessage = {
	type: "NT_OPENCUT_LOAD_PROJECT";
	projectJson?: unknown;
	storageVersion?: number;
	assets?: NtOpenCutAsset[];
};

type NtImportFilesMessage = {
	type: "NT_OPENCUT_IMPORT_FILES";
	files?: File[];
};

type NtGetAiContextMessage = {
	type: "NT_OPENCUT_GET_AI_CONTEXT";
	requestId?: string;
	sessionId?: string;
};

type NtApplyAiEditPlanMessage = {
	type: "NT_OPENCUT_APPLY_AI_EDIT_PLAN";
	requestId?: string;
	sessionId?: string;
	editPlan?: unknown;
};

function isNtLoadProjectMessage(value: unknown): value is NtLoadProjectMessage {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "NT_OPENCUT_LOAD_PROJECT") {
		return false;
	}
	return true;
}

function isNtImportFilesMessage(value: unknown): value is NtImportFilesMessage {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "NT_OPENCUT_IMPORT_FILES") {
		return false;
	}
	return true;
}

function isNtGetAiContextMessage(value: unknown): value is NtGetAiContextMessage {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "NT_OPENCUT_GET_AI_CONTEXT") {
		return false;
	}
	return true;
}

function isNtApplyAiEditPlanMessage(value: unknown): value is NtApplyAiEditPlanMessage {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "NT_OPENCUT_APPLY_AI_EDIT_PLAN") {
		return false;
	}
	return true;
}

/**
 * 宿主（NT）iframe：?embed=1&parentOrigin=
 * - 工程加载完成后向父窗口发送 OPENCUT_READY
 * - 处理 NT_OPENCUT_LOAD_PROJECT（父页注入 NT 持久化的 JSON）
 */
export function useNtHostEmbedBridge(projectId: string) {
	const searchParams = useSearchParams();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const embed = searchParams.get("embed") === "1";
	const rawParent = searchParams.get("parentOrigin");
	const targetOrigin =
		rawParent && rawParent.length > 0 ? rawParent : "*";

	const readySentRef = useRef(false);
	const assetSyncRef = useRef<Promise<void> | null>(null);

	const postToParent = useCallback((payload: Record<string, unknown>) => {
		window.parent?.postMessage(payload, targetOrigin);
	}, [targetOrigin]);

	const syncNtAssets = useCallback(async ({
		assets,
	}: {
		assets: NtOpenCutAsset[];
	}) => {
		const editor = EditorCore.getInstance();
		const existingIds = new Set(editor.media.getAssets().map((asset) => asset.id));
		const importedAssets: MediaAsset[] = [];
		let syncedCount = 0;

		const sortedAssets = [...assets].sort(
			(a, b) => getAssetSyncWeight(a) - getAssetSyncWeight(b),
		);

		for (const ntAsset of sortedAssets) {
			const stableAssetId = `nt-${ntAsset.assetId}`;
			if (existingIds.has(stableAssetId)) continue;
			if (!ntAsset.downloadUrl) continue;

			try {
				const mediaAsset: MediaAsset = {
					id: stableAssetId,
					name: ntAsset.fileName,
					type: ntAsset.typeCode === "AUDIO" ? "audio" : "video",
					file: new File([], ntAsset.fileName, {
						type: ntAsset.mime || undefined,
						lastModified: Date.now(),
					}),
					duration: ntAsset.duration ?? undefined,
					remoteUrl: ntAsset.downloadUrl,
				};

				importedAssets.push(mediaAsset);
				existingIds.add(stableAssetId);
				editor.media.setAssets({
					assets: [...editor.media.getAssets(), mediaAsset],
				});
				editor.project.ratchetFpsForImportedMedia({
					importedAssets: [mediaAsset],
				});
				syncedCount += 1;
				postToParent({
					type: "OPENCUT_ASSET_SYNCED",
					source: "opencut",
					sessionId: projectId,
					assetId: ntAsset.assetId,
					count: syncedCount,
					total: sortedAssets.length,
				});
			} catch (err) {
				console.error("[nt-embed] NT asset sync failed:", ntAsset, err);
				postToParent({
					type: "OPENCUT_ASSET_SYNC_ERROR",
					source: "opencut",
					sessionId: projectId,
					assetId: ntAsset.assetId,
					message: err instanceof Error ? err.message : "Unknown error",
				});
			}
		}

		if (importedAssets.length > 0) {
			postToParent({
				type: "OPENCUT_ASSETS_SYNCED",
				source: "opencut",
				sessionId: projectId,
				count: importedAssets.length,
			});
		}
	}, [postToParent, projectId]);

	const importNtFiles = useCallback(async ({ files }: { files: File[] }) => {
		if (!files.length) return;
		const editor = EditorCore.getInstance();
		postToParent({
			type: "OPENCUT_ASSETS_SYNCING",
			source: "opencut",
			sessionId: projectId,
			count: files.length,
		});
		try {
			const processedAssets = await processMediaAssets({ files });
			let importedCount = 0;
			for (const asset of processedAssets) {
				const imported = await editor.media.addMediaAsset({
					projectId,
					asset,
				});
				if (!imported) continue;
				importedCount += 1;
				postToParent({
					type: "OPENCUT_ASSET_SYNCED",
					source: "opencut",
					sessionId: projectId,
					assetId: imported.id,
					count: importedCount,
					total: processedAssets.length,
				});
			}
			postToParent({
				type: "OPENCUT_ASSETS_SYNCED",
				source: "opencut",
				sessionId: projectId,
				count: importedCount,
			});
		} catch (err) {
			console.error("[nt-embed] NT file import failed:", err);
			postToParent({
				type: "OPENCUT_ASSET_SYNC_ERROR",
				source: "opencut",
				sessionId: projectId,
				message: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}, [postToParent, projectId]);

	useEffect(() => {
		if (!embed) return;

		const onMessage = async (ev: MessageEvent) => {
			if (targetOrigin !== "*" && ev.origin !== targetOrigin) return;
			const raw: unknown = ev.data;
			if (isNtGetAiContextMessage(raw)) {
				postToParent({
					type: "OPENCUT_AI_CONTEXT",
					source: "opencut",
					requestId: raw.requestId,
					...buildNtAiEditContext({
						editor: EditorCore.getInstance(),
						sessionId: projectId,
					}),
				});
				return;
			}
			if (isNtApplyAiEditPlanMessage(raw)) {
				try {
					if (raw.sessionId && raw.sessionId !== projectId) {
						throw new NtAiEditPlanError("AI edit plan session mismatch");
					}
					const result = await applyNtAiEditPlan({
						editor: EditorCore.getInstance(),
						editPlan: raw.editPlan,
					});
					const serialized = await storageService.getSerializedProject({
						id: projectId,
					});
					postToParent({
						type: "OPENCUT_AI_EDIT_APPLIED",
						source: "opencut",
						requestId: raw.requestId,
						sessionId: projectId,
						summary: result.summary,
						appliedActions: result.appliedActions,
						projectJson: serialized,
					});
				} catch (err) {
					console.error("[nt-embed] NT_OPENCUT_APPLY_AI_EDIT_PLAN failed:", err);
					postToParent({
						type: "OPENCUT_AI_EDIT_FAILED",
						source: "opencut",
						requestId: raw.requestId,
						sessionId: projectId,
						message: err instanceof Error ? err.message : "Unknown error",
						failedActionIndex:
							err instanceof NtAiEditPlanError
								? err.failedActionIndex
								: undefined,
					});
				}
				return;
			}
			if (isNtImportFilesMessage(raw)) {
				const files = Array.isArray(raw.files)
					? raw.files.filter((file): file is File =>
							file instanceof File ||
							(
								typeof file === "object" &&
								file !== null &&
								"name" in file &&
								"arrayBuffer" in file
							),
						)
					: [];
				await importNtFiles({ files });
				return;
			}
			if (!isNtLoadProjectMessage(raw)) return;

			const projectJson = raw.projectJson;

			const editor = EditorCore.getInstance();
			try {
				if (projectJson != null) {
					await storageService.setSerializedProject({
						id: projectId,
						// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- NT 宿主受信，与 sessions.projectJson 同源
						serialized: projectJson as SerializedProject,
					});
				}
				await editor.project.loadProject({ id: projectId });
				if (Array.isArray(raw.assets)) {
					postToParent({
						type: "OPENCUT_ASSETS_SYNCING",
						source: "opencut",
						sessionId: projectId,
						count: raw.assets.length,
					});
					assetSyncRef.current = syncNtAssets({ assets: raw.assets }).finally(
						() => {
							assetSyncRef.current = null;
						},
					);
					void assetSyncRef.current;
				}
			} catch (err) {
				console.error("[nt-embed] NT_OPENCUT_LOAD_PROJECT failed:", err);
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embed, importNtFiles, postToParent, projectId, syncNtAssets, targetOrigin]);

	useEffect(() => {
		if (!embed) return;
		if (readySentRef.current) return;
		if (!activeProject || activeProject.metadata.id !== projectId) return;

		readySentRef.current = true;
		postToParent({
			type: "OPENCUT_READY",
			source: "opencut",
			projectId,
		});
	}, [embed, activeProject, postToParent, projectId]);

	useEffect(() => {
		if (!embed) return;
		const editor = EditorCore.getInstance();

		const sendSavedProject = async () => {
			try {
				const serialized = await storageService.getSerializedProject({
					id: projectId,
				});
				if (!serialized) return;
				postToParent({
					type: "OPENCUT_PROJECT_SAVED",
					source: "opencut",
					sessionId: projectId,
					projectJson: serialized,
				});
			} catch (err) {
				console.error("[nt-embed] OPENCUT_PROJECT_SAVED failed:", err);
			}
		};

		return editor.save.subscribeAfterSave(() => {
			void sendSavedProject();
		});
	}, [embed, postToParent, projectId]);
}
