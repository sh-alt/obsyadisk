export interface ObsYaDiskSettings {
	/** Yandex OAuth token */
	yandexToken: string;
	/** Yandex OAuth app client ID */
	yandexClientId: string;
	/** Yandex OAuth app client secret */
	yandexClientSecret: string;
	/** Remote folder path on Yandex.Disk for this vault, e.g. "/ObsidianSync/MyVault" */
	remoteFolderPath: string;
	/** Sync interval in minutes (0 = manual only) */
	syncIntervalMinutes: number;
	/** Enable git-based versioning */
	enableVersioning: boolean;
	/** Auto-commit message template. Use {{date}} for timestamp */
	commitMessageTemplate: string;
	/** Conflict strategy: ask, prefer-local, prefer-remote */
	conflictStrategy: "ask" | "prefer-local" | "prefer-remote";
	/** Exclude patterns (glob-style, one per line) */
	excludePatterns: string[];
	/** Last successful sync timestamp (ISO) */
	lastSyncTimestamp: string;
}

// Bundled client_id — imported here to avoid circular deps
const BUNDLED_CLIENT_ID = "284899b00eb84c77bf1091e65b4bd5ee";

export const DEFAULT_SETTINGS: ObsYaDiskSettings = {
	yandexToken: "",
	yandexClientId: BUNDLED_CLIENT_ID,
	yandexClientSecret: "",
	remoteFolderPath: "/ObsidianSync",
	syncIntervalMinutes: 5,
	enableVersioning: true,
	commitMessageTemplate: "sync {{date}}",
	conflictStrategy: "ask",
	excludePatterns: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash/**"],
	lastSyncTimestamp: "",
};

export interface YaDiskResource {
	name: string;
	path: string;
	type: "dir" | "file";
	modified: string;
	md5?: string;
	size?: number;
	_embedded?: {
		items: YaDiskResource[];
		offset: number;
		limit: number;
		total: number;
	};
}

export interface YaDiskUploadResponse {
	href: string;
	method: string;
	templated: boolean;
}

export interface YaDiskOperationResponse {
	status: string;
}

export interface SyncFileState {
	path: string;
	localModified: number;
	remoteModified: number;
	localMd5: string;
	remoteMd5: string;
}

export type SyncAction =
	| { type: "upload"; path: string }
	| { type: "download"; path: string }
	| { type: "delete-local"; path: string }
	| { type: "delete-remote"; path: string }
	| { type: "conflict"; path: string; localModified: number; remoteModified: number };

export interface ConflictInfo {
	path: string;
	localContent: string;
	remoteContent: string;
	localModified: number;
	remoteModified: number;
}
