import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
	(globalThis as any).Buffer = Buffer;
}

import {
	Plugin,
	Notice,
	TFile,
	addIcon,
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
import { debounce } from "./utils";

const YADISK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;

export default class ObsYaDiskPlugin extends Plugin {
	settings: ObsYaDiskSettings = DEFAULT_SETTINGS;
	yadiskClient: YandexDiskClient = new YandexDiskClient("");
	private oauth!: YandexOAuth;
	syncEngine!: SyncEngine;
	gitVersioning!: GitVersioning;

	private syncTimer: ReturnType<typeof setInterval> | null = null;
	private statusBarEl: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;

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
			this.runSync();
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
	startOAuthFlow() {
		new Notice("ObsYaDisk: Открываем браузер для авторизации...");
		this.oauth.openAuthPage();
	}

	/** Handle the obsidian://obsyadisk-auth callback from the browser */
	private async handleOAuthCallback(params: Record<string, string>) {
		// Authorization code flow: obsidian://obsyadisk-auth?code=CODE
		const code = params["code"];
		// Token flow fallback: obsidian://obsyadisk-auth?access_token=TOKEN
		const directToken = params["access_token"];
		// Error
		const error = params["error"];

		if (error) {
			new Notice(`ObsYaDisk: Ошибка авторизации — ${error}`);
			console.error("ObsYaDisk OAuth error:", error, params["error_description"]);
			return;
		}

		if (directToken) {
			// Token was passed directly (implicit flow)
			this.settings.yandexToken = directToken;
			await this.saveSettings();
			new Notice("ObsYaDisk: Авторизация успешна ✓");
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

		new Notice("ObsYaDisk: Не получен ни code, ни access_token от Яндекса");
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

	private updateStatusBar(state: "idle" | "syncing" | "error" | "done") {
		if (!this.statusBarEl) return;
		switch (state) {
			case "idle":
				this.statusBarEl.setText("YaDisk: ⏸");
				break;
			case "syncing":
				this.statusBarEl.setText("YaDisk: ⟳ синхронизация...");
				break;
			case "error":
				this.statusBarEl.setText("YaDisk: ✗ ошибка");
				break;
			case "done":
				this.statusBarEl.setText("YaDisk: ✓");
				setTimeout(() => this.updateStatusBar("idle"), 5000);
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
		new Notice("ObsYaDisk: Начинаем синхронизацию...");

		try {
			// Git commit before sync (snapshot current state)
			if (this.settings.enableVersioning) {
				try {
					const sha = await this.gitVersioning.commitAll(
						this.settings.commitMessageTemplate
					);
					if (sha) {
						console.log(`ObsYaDisk: Pre-sync commit ${sha.slice(0, 8)}`);
					}
				} catch (e) {
					console.warn("ObsYaDisk: Pre-sync git commit failed:", e);
				}
			}

			// Run sync
			const conflicts = await this.syncEngine.sync();

			// Git commit after sync (snapshot synced state)
			if (this.settings.enableVersioning) {
				try {
					const sha = await this.gitVersioning.commitAll(
						"post-sync {{date}}"
					);
					if (sha) {
						console.log(`ObsYaDisk: Post-sync commit ${sha.slice(0, 8)}`);
					}
				} catch (e) {
					console.warn("ObsYaDisk: Post-sync git commit failed:", e);
				}
			}

			// Handle conflicts
			if (conflicts.length > 0) {
				this.handleConflicts(conflicts);
			} else {
				new Notice("ObsYaDisk: Синхронизация завершена ✓");
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

		this.updateStatusBar("syncing");
		new Notice("ObsYaDisk: Принудительная загрузка на Яндекс.Диск...");

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
				} catch (e) {
					console.error(`ObsYaDisk: Upload failed for ${file.path}:`, e);
				}
			}

			new Notice(`ObsYaDisk: Загружено ${count} файлов ✓`);
			this.updateStatusBar("done");
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

		this.updateStatusBar("syncing");
		new Notice("ObsYaDisk: Принудительная загрузка с Яндекс.Диска...");

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
				} catch (e) {
					console.error(`ObsYaDisk: Download failed for ${localPath}:`, e);
				}
			}

			new Notice(`ObsYaDisk: Загружено ${count} файлов ✓`);
			this.updateStatusBar("done");
		} catch (e) {
			new Notice(`ObsYaDisk: Ошибка — ${(e as Error).message}`);
			this.updateStatusBar("error");
		}
	}
}
