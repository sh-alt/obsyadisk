import { Vault, Notice, normalizePath as obsNormalize } from "obsidian";
import { YandexDiskClient } from "./yandex-disk-client";
import { ObsYaDiskSettings, SyncAction, YaDiskResource } from "./types";
import { isExcluded, computeMd5Hex, bufferToString, normalizePath } from "./utils";

export interface SyncState {
	/** Map of relative path -> { localHash, remoteHash, remoteMd5, lastSyncedHash } */
	files: Record<
		string,
		{
			localHash: string;
			remoteHash: string;
			remoteMd5: string;
			lastSyncedHash: string;
			lastSyncedRemoteHash: string;
		}
	>;
}

export class SyncEngine {
	private vault: Vault;
	private client: YandexDiskClient;
	private settings: ObsYaDiskSettings;
	private syncState: SyncState;
	private isSyncing = false;

	constructor(vault: Vault, client: YandexDiskClient, settings: ObsYaDiskSettings) {
		this.vault = vault;
		this.client = client;
		this.settings = settings;
		this.syncState = { files: {} };
	}

	updateSettings(settings: ObsYaDiskSettings) {
		this.settings = settings;
	}

	getIsSyncing(): boolean {
		return this.isSyncing;
	}

	/** Load sync state from a hidden file in the vault */
	async loadState(): Promise<void> {
		const statePath = obsNormalize(".obsyadisk-state.json");
		try {
			if (await this.vault.adapter.exists(statePath)) {
				const content = await this.vault.adapter.read(statePath);
				this.syncState = JSON.parse(content);
			}
		} catch (e) {
			console.warn("ObsYaDisk: Could not load sync state, starting fresh", e);
			this.syncState = { files: {} };
		}
	}

	/** Save sync state */
	async saveState(): Promise<void> {
		const statePath = obsNormalize(".obsyadisk-state.json");
		await this.vault.adapter.write(statePath, JSON.stringify(this.syncState, null, 2));
	}

	/** Build the remote path for a local file */
	private remotePath(localPath: string): string {
		const base = this.settings.remoteFolderPath.replace(/\/+$/, "");
		return `${base}/${localPath}`;
	}

	/** Strip remote base to get local-relative path */
	private localPath(remoteFullPath: string): string {
		const base = this.settings.remoteFolderPath.replace(/\/+$/, "");
		const prefix = `disk:${base}/`;
		let result = remoteFullPath;
		if (result.startsWith(prefix)) {
			result = result.slice(prefix.length);
		} else {
			// Also handle without "disk:" prefix
			const prefix2 = `${base}/`;
			if (result.startsWith(prefix2)) {
				result = result.slice(prefix2.length);
			}
		}
		// Guard against path traversal
		if (result.split("/").some((seg) => seg === "..")) {
			throw new Error(`Path traversal detected in remote path: ${remoteFullPath}`);
		}
		return result;
	}

	/** Perform a full sync cycle. Returns list of conflicts for UI handling. */
	async sync(): Promise<SyncAction[]> {
		if (this.isSyncing) {
			new Notice("ObsYaDisk: Sync already in progress");
			return [];
		}

		this.isSyncing = true;
		const conflicts: SyncAction[] = [];

		try {
			await this.loadState();

			// 1. Gather local files
			const localFiles = this.vault.getFiles().filter(
				(f) =>
					!f.path.startsWith(".obsyadisk-git") &&
					!f.path.startsWith(".obsyadisk-state") &&
					!isExcluded(f.path, this.settings.excludePatterns)
			);

			const localFileMap = new Map<string, typeof localFiles[0]>();
			for (const f of localFiles) {
				localFileMap.set(normalizePath(f.path), f);
			}

			// 2. Gather remote files
			const remoteBase = this.settings.remoteFolderPath;
			let remoteFiles: YaDiskResource[] = [];
			try {
				remoteFiles = await this.client.listAllFiles(remoteBase);
			} catch (e: any) {
				if (e.message?.includes("404")) {
					// Remote folder doesn't exist yet, create it
					await this.client.mkdir(remoteBase);
				} else {
					throw e;
				}
			}

			const remoteFileMap = new Map<string, YaDiskResource>();
			for (const rf of remoteFiles) {
				const lp = this.localPath(rf.path);
				if (!isExcluded(lp, this.settings.excludePatterns)) {
					remoteFileMap.set(normalizePath(lp), rf);
				}
			}

			// 3. Determine actions
			const actions: SyncAction[] = [];

			// 3a. Check local files
			for (const [localPath, file] of localFileMap) {
				const content = await this.vault.readBinary(file);
				const localHash = computeMd5Hex(content);
				const state = this.syncState.files[localPath];
				const remote = remoteFileMap.get(localPath);

				if (!remote) {
					// File exists locally but not remotely
					if (state && state.lastSyncedRemoteHash) {
						// Was previously synced -> deleted on remote
						actions.push({ type: "delete-local", path: localPath });
					} else {
						// New local file -> upload
						actions.push({ type: "upload", path: localPath });
					}
				} else {
					const remoteHash = remote.md5 || remote.modified;
					const localChanged = !state || state.localHash !== localHash;
					const remoteChanged =
						!state || (state.remoteMd5 || state.remoteHash) !== (remote.md5 || remote.modified);

					if (localChanged && remoteChanged) {
						// Both changed -> conflict
						actions.push({
							type: "conflict",
							path: localPath,
							localModified: file.stat.mtime,
							remoteModified: new Date(remote.modified).getTime(),
						});
					} else if (localChanged) {
						actions.push({ type: "upload", path: localPath });
					} else if (remoteChanged) {
						actions.push({ type: "download", path: localPath });
					}
					// else: no changes
				}
			}

			// 3b. Check remote-only files (new on remote or deleted locally)
			for (const [remotePath, resource] of remoteFileMap) {
				if (!localFileMap.has(remotePath)) {
					const state = this.syncState.files[remotePath];
					if (state && state.lastSyncedHash) {
						// Was previously synced -> deleted locally
						actions.push({ type: "delete-remote", path: remotePath });
					} else {
						// New remote file -> download
						actions.push({ type: "download", path: remotePath });
					}
				}
			}

			// 4. Execute non-conflict actions
			for (const action of actions) {
				try {
					switch (action.type) {
						case "upload":
							await this.executeUpload(action.path);
							break;
						case "download":
							await this.executeDownload(action.path);
							break;
						case "delete-local":
							await this.executeDeleteLocal(action.path);
							break;
						case "delete-remote":
							await this.executeDeleteRemote(action.path);
							break;
						case "conflict":
							conflicts.push(action);
							break;
					}
				} catch (e) {
					console.error(`ObsYaDisk: Failed to execute ${action.type} for ${action.path}:`, e);
					new Notice(`ObsYaDisk: Error syncing ${action.path}`);
				}
			}

			// 5. Update sync state for non-conflict files
			await this.rebuildState();
			await this.saveState();

			this.settings.lastSyncTimestamp = new Date().toISOString();
		} catch (e) {
			console.error("ObsYaDisk: Sync error:", e);
			new Notice(`ObsYaDisk: Sync failed — ${(e as Error).message}`);
		} finally {
			this.isSyncing = false;
		}

		return conflicts;
	}

	/** Upload a local file to remote */
	async executeUpload(localPath: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(localPath);
		if (!file) return;
		const content = await this.vault.adapter.readBinary(localPath);
		await this.client.uploadFile(this.remotePath(localPath), content);
	}

	/** Download a remote file to local vault */
	async executeDownload(localPath: string): Promise<void> {
		// Guard against path traversal
		if (localPath.split("/").some((seg) => seg === "..")) {
			throw new Error(`Path traversal detected: ${localPath}`);
		}
		const rp = this.remotePath(localPath);
		const content = await this.client.downloadFile(rp);

		// Ensure parent directories exist
		const dir = localPath.replace(/\/[^/]+$/, "");
		if (dir && !(await this.vault.adapter.exists(dir))) {
			await this.vault.adapter.mkdir(dir);
		}

		await this.vault.adapter.writeBinary(obsNormalize(localPath), content);
	}

	/** Delete a local file */
	async executeDeleteLocal(localPath: string): Promise<void> {
		if (await this.vault.adapter.exists(localPath)) {
			await this.vault.adapter.remove(localPath);
		}
		delete this.syncState.files[localPath];
	}

	/** Delete a remote file */
	async executeDeleteRemote(localPath: string): Promise<void> {
		try {
			await this.client.deleteResource(this.remotePath(localPath));
		} catch {
			// Ignore if already gone
		}
		delete this.syncState.files[localPath];
	}

	/** Resolve a conflict by choosing a side */
	async resolveConflict(
		localPath: string,
		resolution: "local" | "remote"
	): Promise<void> {
		if (resolution === "local") {
			await this.executeUpload(localPath);
		} else {
			await this.executeDownload(localPath);
		}
		await this.rebuildState();
		await this.saveState();
	}

	/** Rebuild sync state from current local and remote files */
	private async rebuildState(): Promise<void> {
		const localFiles = this.vault.getFiles().filter(
			(f) =>
				!f.path.startsWith(".obsyadisk-git") &&
				!f.path.startsWith(".obsyadisk-state") &&
				!isExcluded(f.path, this.settings.excludePatterns)
		);

		for (const file of localFiles) {
			const p = normalizePath(file.path);
			try {
				const content = await this.vault.readBinary(file);
				const hash = computeMd5Hex(content);

				// Try to get remote info
				let remoteHash = "";
				let remoteMd5 = "";
				try {
					const resource = await this.client.getResource(this.remotePath(p));
					if (resource) {
						remoteHash = resource.modified;
						remoteMd5 = resource.md5 || "";
					}
				} catch {
					// Remote doesn't exist
				}

				this.syncState.files[p] = {
					localHash: hash,
					remoteHash,
					remoteMd5,
					lastSyncedHash: hash,
					lastSyncedRemoteHash: remoteHash,
				};
			} catch {
				// Skip unreadable files
			}
		}
	}
}
