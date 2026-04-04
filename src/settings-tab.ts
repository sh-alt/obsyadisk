import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type ObsYaDiskPlugin from "./main";

export class ObsYaDiskSettingTab extends PluginSettingTab {
	plugin: ObsYaDiskPlugin;

	constructor(app: App, plugin: ObsYaDiskPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h1", { text: "ObsYaDisk — Синхронизация с Яндекс.Диском" });

		// --- Auth section ---
		containerEl.createEl("h2", { text: "Авторизация" });

		// Show current auth status
		const isAuthed = !!this.plugin.settings.yandexToken;
		const authStatusEl = containerEl.createDiv({ cls: "obsyadisk-auth-status" });
		if (isAuthed) {
			authStatusEl.createEl("span", {
				text: "✓ Авторизован",
				cls: "obsyadisk-auth-ok",
			});
		} else {
			authStatusEl.createEl("span", {
				text: "✗ Не авторизован",
				cls: "obsyadisk-auth-none",
			});
		}

		// Main auth button — opens browser
		const authBtnSetting = new Setting(containerEl)
			.setName("Авторизоваться через Яндекс")
			.setDesc(
				"Откроется браузер, вы войдёте в Яндекс, и токен автоматически вернётся в плагин."
			);

		authBtnSetting.addButton((btn) =>
			btn
				.setButtonText(isAuthed ? "Переавторизоваться" : "Авторизоваться")
				.setCta()
				.onClick(() => this.plugin.startOAuthFlow())
		);

		if (isAuthed) {
			authBtnSetting.addButton((btn) =>
				btn
					.setButtonText("Выйти")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.yandexToken = "";
						await this.plugin.saveSettings();
						this.display();
						new Notice("ObsYaDisk: Токен удалён");
					})
			);
		}

		// Advanced / custom credentials — collapsible
		const advancedEl = containerEl.createEl("details", { cls: "obsyadisk-advanced" });
		advancedEl.createEl("summary", { text: "Расширенные настройки (свой OAuth-токен или приложение)" });

		new Setting(advancedEl)
			.setName("OAuth-токен (вручную)")
			.setDesc("Вставьте токен вручную, если браузерная авторизация недоступна")
			.addText((text) =>
				text
					.setPlaceholder("y0_AgAAAA...")
					.setValue(this.plugin.settings.yandexToken)
					.onChange(async (value) => {
						this.plugin.settings.yandexToken = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(advancedEl)
			.setName("Client ID приложения")
			.setDesc("Оставьте пустым чтобы использовать встроенное приложение. Заполните если хотите использовать собственное OAuth-приложение с oauth.yandex.ru (redirect URI: obsidian://obsyadisk-auth)")
			.addText((text) =>
				text
					.setPlaceholder("(встроенное приложение)")
					.setValue(this.plugin.settings.yandexClientId === "284899b00eb84c77bf1091e65b4bd5ee" ? "" : this.plugin.settings.yandexClientId)
					.onChange(async (value) => {
						this.plugin.settings.yandexClientId = value.trim() || "284899b00eb84c77bf1091e65b4bd5ee";
						await this.plugin.saveSettings();
					})
			);

		new Setting(advancedEl)
			.setName("Client Secret приложения")
			.setDesc("Только если используете своё OAuth-приложение")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("секрет...")
					.setValue(this.plugin.settings.yandexClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.yandexClientSecret = value.trim();
						await this.plugin.saveSettings();
					});
				return text;
			});

		new Setting(containerEl)
			.setName("Проверить токен")
			.setDesc("Убедиться, что токен рабочий")
			.addButton((btn) =>
				btn.setButtonText("Проверить").onClick(async () => {
					if (!this.plugin.settings.yandexToken) {
						new Notice("Нет токена — авторизуйтесь");
						return;
					}
					try {
						const ok = await this.plugin.yadiskClient.checkToken();
						new Notice(ok ? "✓ Токен валиден" : "✗ Токен невалиден");
					} catch (e) {
						new Notice(`Ошибка: ${(e as Error).message}`);
					}
				})
			);

		// --- Sync section ---
		containerEl.createEl("h2", { text: "Синхронизация" });

		new Setting(containerEl)
			.setName("Папка на Яндекс.Диске")
			.setDesc(
				"Путь к папке на Яндекс.Диске для этого хранилища. Каждому vault — своя папка."
			)
			.addText((text) =>
				text
					.setPlaceholder("/ObsidianSync/MyVault")
					.setValue(this.plugin.settings.remoteFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.remoteFolderPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Интервал синхронизации (мин)")
			.setDesc("0 = только ручная синхронизация")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.syncIntervalMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.restartSyncTimer();
						}
					})
			);

		new Setting(containerEl)
			.setName("Стратегия конфликтов")
			.setDesc("Что делать, когда файл изменён и локально, и удалённо")
			.addDropdown((drop) =>
				drop
					.addOption("ask", "Спрашивать")
					.addOption("prefer-local", "Локальная версия приоритетнее")
					.addOption("prefer-remote", "Удалённая версия приоритетнее")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value: string) => {
						this.plugin.settings.conflictStrategy = value as any;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Исключения")
			.setDesc("Паттерны файлов для исключения из синхронизации (по одному на строку, glob)")
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian/workspace.json\n.trash/**")
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		// --- Versioning section ---
		containerEl.createEl("h2", { text: "Версионирование (Git)" });

		new Setting(containerEl)
			.setName("Включить версионирование")
			.setDesc("Создавать git-коммиты при каждой синхронизации для отслеживания истории изменений")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVersioning)
					.onChange(async (value) => {
						this.plugin.settings.enableVersioning = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Шаблон сообщения коммита")
			.setDesc("Используйте {{date}} для подстановки даты/времени")
			.addText((text) =>
				text
					.setPlaceholder("sync {{date}}")
					.setValue(this.plugin.settings.commitMessageTemplate)
					.onChange(async (value) => {
						this.plugin.settings.commitMessageTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Info section ---
		containerEl.createEl("h2", { text: "Информация" });

		const lastSync = this.plugin.settings.lastSyncTimestamp
			? new Date(this.plugin.settings.lastSyncTimestamp).toLocaleString()
			: "никогда";

		const lastSyncSetting = new Setting(containerEl)
			.setName("Последняя синхронизация")
			.setDesc(lastSync);
		this.plugin.lastSyncDescEl = lastSyncSetting.descEl;

		// --- Debug section ---
		containerEl.createEl("h2", { text: "Диагностика" });

		new Setting(containerEl)
			.setName("Тест git-версионирования")
			.setDesc("Пошаговая проверка файловых операций. Результат — в консоли (Ctrl+Shift+I) и уведомлениях.")
			.addButton((btn) =>
				btn.setButtonText("Запустить диагностику").onClick(async () => {
					new Notice("ObsYaDisk: Запускаем диагностику git...");
					const lines = await this.plugin.gitVersioning.diagnose();
					console.log("=== ObsYaDisk Git Diagnostics ===");
					for (const line of lines) {
						console.log(line);
						new Notice(`Git: ${line}`, 8000);
					}
				})
			);
	}
}
