import type { ExportOptions } from "./index";

export const DEFAULT_EXPORT_OPTIONS = {
	format: "mp4",
	quality: "medium",
	includeAudio: true,
} satisfies ExportOptions;
