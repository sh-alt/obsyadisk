import { App, Modal, Setting, ButtonComponent } from "obsidian";
import { GitVersioning } from "./git-versioning";

export class VersionHistoryModal extends Modal {
	private git: GitVersioning;
	private filePath: string | null;

	constructor(app: App, git: GitVersioning, filePath: string | null = null) {
		super(app);
		this.git = git;
		this.filePath = filePath;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("obsyadisk-version-modal");

		contentEl.createEl("h2", { text: "ObsYaDisk: История версий" });

		const log = await this.git.getLog(50);

		if (log.length === 0) {
			contentEl.createEl("p", { text: "История пуста. Выполните синхронизацию для создания первого коммита." });
			return;
		}

		const listEl = contentEl.createDiv({ cls: "obsyadisk-version-list" });

		for (const entry of log) {
			const itemEl = listEl.createDiv({ cls: "obsyadisk-version-item" });

			const infoEl = itemEl.createDiv({ cls: "obsyadisk-version-info" });
			infoEl.createEl("strong", { text: entry.message.trim() });
			infoEl.createEl("div", {
				text: `${entry.date.toLocaleString()} — ${entry.sha.slice(0, 8)}`,
				cls: "obsyadisk-version-meta",
			});

			if (this.filePath) {
				new ButtonComponent(itemEl)
					.setButtonText("Восстановить")
					.setWarning()
					.onClick(async () => {
						const success = await this.git.restoreFile(this.filePath!, entry.sha);
						if (success) {
							itemEl.createEl("span", {
								text: " ✓ Восстановлено",
								cls: "obsyadisk-restored-label",
							});
						} else {
							itemEl.createEl("span", {
								text: " ✗ Файл не найден в этом коммите",
								cls: "obsyadisk-error-label",
							});
						}
					});
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
