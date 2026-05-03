"use client";

import { Suspense } from "react";
import { useNtHostEmbedBridge } from "@/lib/nt-embed-bridge";

function NtEmbedBridgeInner({ projectId }: { projectId: string }) {
	useNtHostEmbedBridge(projectId);
	return null;
}

export function NtEmbedBridge({ projectId }: { projectId: string }) {
	return (
		<Suspense fallback={null}>
			<NtEmbedBridgeInner projectId={projectId} />
		</Suspense>
	);
}
