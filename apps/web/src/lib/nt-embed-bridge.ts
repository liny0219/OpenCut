"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";

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

type NtLoadProjectMessage = {
	type: "NT_OPENCUT_LOAD_PROJECT";
	projectJson?: unknown;
	storageVersion?: number;
	assets?: NtOpenCutAsset[];
};

function isNtLoadProjectMessage(value: unknown): value is NtLoadProjectMessage {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || value.type !== "NT_OPENCUT_LOAD_PROJECT") {
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

		for (const ntAsset of assets) {
			const stableAssetId = `nt-${ntAsset.assetId}`;
			if (existingIds.has(stableAssetId)) continue;
			if (!ntAsset.downloadUrl) continue;

			try {
				const response = await fetch(ntAsset.downloadUrl);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}

				const blob = await response.blob();
				const file = new File([blob], ntAsset.fileName, {
					type: ntAsset.mime || blob.type || undefined,
					lastModified: Date.now(),
				});
				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed) continue;

				const mediaAsset: MediaAsset = {
					...processed,
					id: stableAssetId,
					duration: processed.duration ?? ntAsset.duration ?? undefined,
				};

				await storageService.saveMediaAsset({
					projectId,
					mediaAsset,
				});
				importedAssets.push(mediaAsset);
				existingIds.add(stableAssetId);
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
			editor.media.setAssets({
				assets: [...editor.media.getAssets(), ...importedAssets],
			});
			editor.project.ratchetFpsForImportedMedia({
				importedAssets,
			});
			postToParent({
				type: "OPENCUT_ASSETS_SYNCED",
				source: "opencut",
				sessionId: projectId,
				count: importedAssets.length,
			});
		}
	}, [postToParent, projectId]);

	useEffect(() => {
		if (!embed) return;

		const onMessage = async (ev: MessageEvent) => {
			if (targetOrigin !== "*" && ev.origin !== targetOrigin) return;
			const raw: unknown = ev.data;
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
					assetSyncRef.current = syncNtAssets({ assets: raw.assets });
					await assetSyncRef.current;
					assetSyncRef.current = null;
				}
			} catch (err) {
				console.error("[nt-embed] NT_OPENCUT_LOAD_PROJECT failed:", err);
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embed, projectId, syncNtAssets, targetOrigin]);

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
				if (assetSyncRef.current) {
					await assetSyncRef.current;
				}
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
