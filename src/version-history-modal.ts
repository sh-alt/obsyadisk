import { App, Modal, Notice, Setting, ButtonComponent } from "obsidian";
import { GitVersioning } from "./git-versioning";
import { DiffModal } from "./diff-modal";

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
					.setButtonText("Diff")
					.onClick(async () => {
						const result = await this.git.getDiff(this.filePath!, entry.sha);
						if (!result) {
							new Notice("ObsYaDisk: Не удалось получить diff (файл отсутствует или бинарный)");
							return;
						}
						new DiffModal(this.app, this.filePath!, entry.sha, result.oldText, result.newText).open();
					});

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

			// Show changed files for any commit (not just file-specific)
			const changesBtn = new ButtonComponent(itemEl)
				.setButtonText("Файлы")
				.onClick(async () => {
					const existing = itemEl.querySelector(".obsyadisk-commit-files");
					if (existing) {
						const el = existing as HTMLElement;
						el.style.display = el.style.display === "none" ? "" : "none";
						return;
					}
					const filesEl = itemEl.createDiv({ cls: "obsyadisk-commit-files" });
					filesEl.setText("Загрузка...");
					const changed = await this.git.getCommitChangedFiles(entry.sha);
					filesEl.empty();
					if (changed.length === 0) {
						filesEl.setText("Нет изменений или первый коммит");
						return;
					}
					for (const f of changed) {
						const icon = f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~";
						const cls = f.status === "added"
							? "obsyadisk-file-added"
							: f.status === "deleted"
							? "obsyadisk-file-deleted"
							: "obsyadisk-file-modified";
						filesEl.createDiv({ cls }).createEl("code", { text: `${icon} ${f.path}` });
					}
				});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
