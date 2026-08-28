import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
	(globalThis as any).Buffer = Buffer;
}

import {
	Plugin,
	Notice,
	TFile,
	addIcon,
	setIcon,
	Menu,
	MenuItem,
} from "obsidian";
import { ObsYaDiskSettings, DEFAULT_SETTINGS, SyncAction } from "./types";
import { YandexDiskClient } from "./yandex-disk-client";
import { YandexOAuth, BUNDLED_CLIENT_ID } from "./yandex-oauth";
import { SyncEngine } from "./sync-engine";
import { GitVersioning } from "./git-versioning";
import { ObsYaDiskSettingTab } from "./settings-tab";
import { ConflictModal } from "./conflict-modal";
import { VersionHistoryModal } from "./version-history-modal";
import { isExcluded } from "./utils";

const YADISK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

export default class ObsYaDiskPlugin extends Plugin {
	settings: ObsYaDiskSettings = DEFAULT_SETTINGS;
	yadiskClient: YandexDiskClient = new YandexDiskClient("");
	private oauth!: YandexOAuth;
	syncEngine!: SyncEngine;
	gitVersioning!: GitVersioning;

	private syncTimer: ReturnType<typeof setInterval> | null = null;
	private syncDoneTimer: ReturnType<typeof setTimeout> | null = null;
	private fileChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusIconEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	lastSyncDescEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize clients
		this.yadiskClient = new YandexDiskClient(this.settings.yandexToken);
		this.syncEngine = new SyncEngine(this.app.vault, this.yadiskClient, this.settings);
		this.gitVersioning = new GitVersioning(this.app.vault);
		this.initOAuth();

		// Register obsidian:// protocol handler for OAuth callback
		this.registerObsidianProtocolHandler("obsyadisk-auth", async (params) => {
			await this.handleOAuthCallback(params);
		});

		// Initialize git if versioning enabled
		if (this.settings.enableVersioning) {
			try {
				await this.gitVersioning.init();
			} catch (e) {
				console.error("ObsYaDisk: Git init failed:", e);
			}
		}

		// Register ribbon icon
		addIcon("obsyadisk", YADISK_ICON);
		this.ribbonIconEl = this.addRibbonIcon("obsyadisk", "ObsYaDisk: Синхронизировать", () => {
			if (this.syncEngine.getIsSyncing()) {
				if (this.syncEngine.isAbortRequested()) {
					new Notice("ObsYaDisk: Дождитесь завершения остановки...");
				} else {
					this.syncEngine.abort();
					this.updateStatusBar("stopping");
				}
			} else {
				this.runSync();
			}
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("idle");

		// Commands
		this.addCommand({
			id: "obsyadisk-sync",
			name: "Синхронизировать с Яндекс.Диском",
			callback: () => this.runSync(),
		});

		this.addCommand({
			id: "obsyadisk-stop-sync",
			name: "Остановить синхронизацию",
			callback: () => {
				if (this.syncEngine.getIsSyncing() && !this.syncEngine.isAbortRequested()) {
					this.syncEngine.abort();
					this.updateStatusBar("stopping");
				} else if (!this.syncEngine.getIsSyncing()) {
					new Notice("ObsYaDisk: Синхронизация не выполняется");
				}
			},
		});

		this.addCommand({
			id: "obsyadisk-force-upload",
			name: "Принудительная загрузка на Яндекс.Диск",
			callback: () => this.forceUploadAll(),
		});

		this.addCommand({
			id: "obsyadisk-force-download",
			name: "Принудительная загрузка с Яндекс.Диска",
			callback: () => this.forceDownloadAll(),
		});

		this.addCommand({
			id: "obsyadisk-version-history",
			name: "История версий (Git)",
			callback: () => {
				new VersionHistoryModal(this.app, this.gitVersioning).open();
			},
		});

		this.addCommand({
			id: "obsyadisk-version-history-file",
			name: "История версий текущего файла",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (checking) return !!file;
				if (file) {
					new VersionHistoryModal(this.app, this.gitVersioning, file.path).open();
				}
			},
		});

		// File menu: version history for specific file
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile) {
					menu.addItem((item: MenuItem) => {
						item
							.setTitle("ObsYaDisk: История версий")
							.setIcon("obsyadisk")
							.onClick(() => {
								new VersionHistoryModal(
									this.app,
									this.gitVersioning,
									file.path
								).open();
							});
					});
				}
			})
		);

		// Debounced sync on file change (opt-in via fileChangeDebounceSeconds)
		this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileChanged(file.path)));
		this.registerEvent(this.app.vault.on("create", (file) => this.onVaultFileChanged(file.path)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultFileChanged(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file) => this.onVaultFileChanged(file.path)));

		// Settings tab
		this.addSettingTab(new ObsYaDiskSettingTab(this.app, this));

		// Auto-sync timer
		this.restartSyncTimer();

		// Sync state loading
		await this.syncEngine.loadState();

		console.log("ObsYaDisk plugin loaded");
	}

	onunload() {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		if (this.fileChangeTimer) {
			clearTimeout(this.fileChangeTimer);
			this.fileChangeTimer = null;
		}
		console.log("ObsYaDisk plugin unloaded");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.yadiskClient.setToken(this.settings.yandexToken);
		this.syncEngine.updateSettings(this.settings);
		this.initOAuth();
	}

	/** Initialize or re-initialize the OAuth client from current settings */
	private initOAuth() {
		this.oauth = new YandexOAuth({
			clientId: this.settings.yandexClientId || BUNDLED_CLIENT_ID,
			clientSecret: this.settings.yandexClientSecret,
		});
	}

	/** Open the browser to start the Yandex OAuth authorization flow */
	async startOAuthFlow() {
		new Notice("ObsYaDisk: Открываем браузер для авторизации...");
		await this.oauth.openAuthPage();
	}

	/** Handle the obsidian://obsyadisk-auth callback from the browser */
	private async handleOAuthCallback(params: Record<string, string>) {
		// Authorization code flow: obsidian://obsyadisk-auth?code=CODE
		const code = params["code"];
		const error = params["error"];

		if (error) {
			new Notice(`ObsYaDisk: Ошибка авторизации — ${error}`);
			console.error("ObsYaDisk OAuth error:", error, params["error_description"]);
			return;
		}

		if (code) {
			if (!this.oauth) {
				new Notice("ObsYaDisk: OAuth не настроен — укажите Client ID");
				return;
			}

			new Notice("ObsYaDisk: Обмениваем код на токен...");
			try {
				const tokenResp = await this.oauth.exchangeCodeForToken(code);
				if (tokenResp.error) {
					new Notice(`ObsYaDisk: Ошибка — ${tokenResp.error_description || tokenResp.error}`);
					return;
				}
				this.settings.yandexToken = tokenResp.access_token;
				await this.saveSettings();
				new Notice("ObsYaDisk: Авторизация успешна ✓");
			} catch (e) {
				console.error("ObsYaDisk: Token exchange failed:", e);
				new Notice(`ObsYaDisk: Не удалось получить токен — ${(e as Error).message}`);
			}
			return;
		}

		new Notice("ObsYaDisk: Не получен code от Яндекса");
	}

	/** Vault file/create/delete/rename handler — schedules a debounced sync */
	private onVaultFileChanged(path: string) {
		if (!this.settings.yandexToken) return;
		if (this.settings.fileChangeDebounceSeconds <= 0) return;
		// Ignore our own writes (sync state file, git repo) to avoid re-triggering ourselves
		if (path.startsWith(".obsyadisk-")) return;
		if (isExcluded(path, this.settings.excludePatterns)) return;

		if (this.fileChangeTimer) clearTimeout(this.fileChangeTimer);
		this.fileChangeTimer = setTimeout(() => {
			this.fileChangeTimer = null;
			if (!this.syncEngine.getIsSyncing()) this.runSync();
		}, this.settings.fileChangeDebounceSeconds * 1000);
	}

	restartSyncTimer() {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = null;
		}

		if (this.settings.syncIntervalMinutes > 0) {
			const ms = this.settings.syncIntervalMinutes * 60 * 1000;
			this.syncTimer = setInterval(() => this.runSync(), ms);
		}
	}

	/** (Re)builds the status bar as an icon + text pair; detail overrides the default text. */
	private updateStatusBar(
		state: "idle" | "syncing" | "stopping" | "stopped" | "error" | "done",
		detail?: string
	) {
		if (!this.statusBarEl) return;
		if (state !== "syncing" && this.syncDoneTimer) {
			clearTimeout(this.syncDoneTimer);
			this.syncDoneTimer = null;
		}

		this.statusBarEl.empty();
		this.statusBarEl.addClass("obsyadisk-status");
		this.statusIconEl = this.statusBarEl.createSpan({ cls: "obsyadisk-status-icon" });
		this.statusTextEl = this.statusBarEl.createSpan({ cls: "obsyadisk-status-text" });

		switch (state) {
			case "idle":
				setIcon(this.statusIconEl, "cloud");
				this.statusTextEl.setText("YaDisk");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Синхронизировать");
				break;
			case "syncing":
				this.statusIconEl.addClass("obsyadisk-spin");
				setIcon(this.statusIconEl, "refresh-cw");
				this.statusTextEl.setText(detail ?? "синхронизация...");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Остановить синхронизацию");
				break;
			case "stopping":
				setIcon(this.statusIconEl, "octagon-x");
				this.statusTextEl.setText("остановка...");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Дождитесь остановки...");
				break;
			case "stopped":
				setIcon(this.statusIconEl, "octagon-x");
				this.statusTextEl.setText("остановлено");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Синхронизировать");
				this.syncDoneTimer = setTimeout(() => {
					this.syncDoneTimer = null;
					this.updateStatusBar("idle");
				}, 3000);
				break;
			case "error":
				setIcon(this.statusIconEl, "alert-circle");
				this.statusTextEl.setText(detail ?? "ошибка");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Синхронизировать");
				break;
			case "done":
				setIcon(this.statusIconEl, "check-circle-2");
				this.statusTextEl.setText(detail ?? "готово");
				this.ribbonIconEl?.setAttr("aria-label", "ObsYaDisk: Синхронизировать");
				this.syncDoneTimer = setTimeout(() => {
					this.syncDoneTimer = null;
					this.updateStatusBar("idle");
				}, 5000);
				break;
		}
	}

	async runSync() {
		if (!this.settings.yandexToken) {
			new Notice("ObsYaDisk: Настройте OAuth-токен Яндекса в параметрах плагина");
			return;
		}

		if (this.syncEngine.getIsSyncing()) {
			new Notice("ObsYaDisk: Синхронизация уже выполняется");
			return;
		}

		this.updateStatusBar("syncing");

		try {
			// Run sync
			const conflicts = await this.syncEngine.sync((done, total, file) => {
				if (!this.statusTextEl) return;
				if (total === 0) {
					this.statusTextEl.setText("анализ...");
				} else {
					const pct = Math.round((done / total) * 100);
					this.statusTextEl.setText(`${done}/${total} (${pct}%)`);
				}
			});

			// Check if sync was stopped by user
			if (this.syncEngine.wasAborted()) {
				this.updateStatusBar("stopped");
				await this.saveSettings();
				return;
			}

			// Handle conflicts
			if (conflicts.length > 0) {
				this.handleConflicts(conflicts);
			}

			// Git commit — one per sync, only if user files actually changed
			if (this.settings.enableVersioning) {
				try {
					const sha = await this.gitVersioning.commitAll(
						this.settings.commitMessageTemplate
					);
					if (sha) console.log(`ObsYaDisk: Git commit ${sha.slice(0, 8)}`);
				} catch (e) {
					console.warn("ObsYaDisk: Git commit failed:", e);
				}
			}

			this.settings.lastSyncTimestamp = new Date().toISOString();
			if (this.lastSyncDescEl) {
				this.lastSyncDescEl.setText(
					new Date(this.settings.lastSyncTimestamp).toLocaleString()
				);
			}
			this.updateStatusBar("done");
			await this.saveSettings();
		} catch (e) {
			console.error("ObsYaDisk: Sync failed:", e);
			new Notice(`ObsYaDisk: Ошибка синхронизации — ${(e as Error).message}`);
			this.updateStatusBar("error");
		}
	}

	private handleConflicts(conflicts: SyncAction[]) {
		const strategy = this.settings.conflictStrategy;

		if (strategy === "prefer-local") {
			for (const c of conflicts) {
				if (c.type === "conflict") {
					this.syncEngine.resolveConflict(c.path, "local");
				}
			}
			new Notice(`ObsYaDisk: ${conflicts.length} конфликтов разрешено (локальная версия)`);
		} else if (strategy === "prefer-remote") {
			for (const c of conflicts) {
				if (c.type === "conflict") {
					this.syncEngine.resolveConflict(c.path, "remote");
				}
			}
			new Notice(`ObsYaDisk: ${conflicts.length} конфликтов разрешено (удалённая версия)`);
		} else {
			// strategy === "ask"
			new ConflictModal(this.app, conflicts, this.syncEngine, () => {
				new Notice("ObsYaDisk: Все конфликты разрешены ✓");
			}).open();
		}
	}

	/** Force upload everything, ignoring sync state */
	private async forceUploadAll() {
		if (!this.settings.yandexToken) {
			new Notice("ObsYaDisk: Настройте OAuth-токен");
			return;
		}

		this.updateStatusBar("syncing", "загрузка на диск...");

		try {
			const files = this.app.vault.getFiles().filter(
				(f) =>
					!f.path.startsWith(".obsyadisk-git") &&
					!f.path.startsWith(".obsyadisk-state")
			);

			let count = 0;
			for (const file of files) {
				try {
					await this.syncEngine.executeUpload(file.path);
					count++;
					if (this.statusTextEl) this.statusTextEl.setText(`${count}/${files.length}`);
				} catch (e) {
					console.error(`ObsYaDisk: Upload failed for ${file.path}:`, e);
				}
			}

			this.updateStatusBar("done", `загружено ${count} файлов`);
		} catch (e) {
			new Notice(`ObsYaDisk: Ошибка — ${(e as Error).message}`);
			this.updateStatusBar("error");
		}
	}

	/** Force download everything from remote */
	private async forceDownloadAll() {
		if (!this.settings.yandexToken) {
			new Notice("ObsYaDisk: Настройте OAuth-токен");
			return;
		}

		this.updateStatusBar("syncing", "загрузка с диска...");

		try {
			const remoteFiles = await this.yadiskClient.listAllFiles(
				this.settings.remoteFolderPath
			);

			let count = 0;
			for (const rf of remoteFiles) {
				const base = this.settings.remoteFolderPath.replace(/\/+$/, "");
				const prefix = `disk:${base}/`;
				let localPath = rf.path;
				if (localPath.startsWith(prefix)) {
					localPath = localPath.slice(prefix.length);
				} else if (localPath.startsWith(`${base}/`)) {
					localPath = localPath.slice(base.length + 1);
				}

				try {
					await this.syncEngine.executeDownload(localPath);
					count++;
					if (this.statusTextEl) this.statusTextEl.setText(`${count}/${remoteFiles.length}`);
				} catch (e) {
					console.error(`ObsYaDisk: Download failed for ${localPath}:`, e);
				}
			}

			this.updateStatusBar("done", `загружено ${count} файлов`);
		} catch (e) {
			new Notice(`ObsYaDisk: Ошибка — ${(e as Error).message}`);
			this.updateStatusBar("error");
		}
	}
}
