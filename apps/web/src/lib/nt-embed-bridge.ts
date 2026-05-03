"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { storageService } from "@/services/storage/service";

type SerializedProject = import("@/services/storage/types").SerializedProject;

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

	useEffect(() => {
		if (!embed) return;

		const onMessage = async (ev: MessageEvent) => {
			if (targetOrigin !== "*" && ev.origin !== targetOrigin) return;
			const raw: unknown = ev.data;
			if (typeof raw !== "object" || raw === null) return;
			if (!("type" in raw) || raw.type !== "NT_OPENCUT_LOAD_PROJECT") return;

			const projectJson =
				"projectJson" in raw ? raw.projectJson : undefined;

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
			} catch (err) {
				console.error("[nt-embed] NT_OPENCUT_LOAD_PROJECT failed:", err);
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embed, projectId, targetOrigin]);

	useEffect(() => {
		if (!embed) return;
		if (readySentRef.current) return;
		if (!activeProject || activeProject.metadata.id !== projectId) return;

		readySentRef.current = true;
		window.parent?.postMessage(
			{
				type: "OPENCUT_READY",
				source: "opencut",
				projectId,
			},
			targetOrigin,
		);
	}, [embed, activeProject, projectId, targetOrigin]);
}
