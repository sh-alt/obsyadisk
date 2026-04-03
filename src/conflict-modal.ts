import { App, Modal, Setting, ButtonComponent } from "obsidian";
import { SyncAction } from "./types";
import { SyncEngine } from "./sync-engine";

export class ConflictModal extends Modal {
	private conflicts: SyncAction[];
	private syncEngine: SyncEngine;
	private onComplete: () => void;

	constructor(
		app: App,
		conflicts: SyncAction[],
		syncEngine: SyncEngine,
		onComplete: () => void
	) {
		super(app);
		this.conflicts = conflicts;
		this.syncEngine = syncEngine;
		this.onComplete = onComplete;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("obsyadisk-conflict-modal");

		contentEl.createEl("h2", { text: "ObsYaDisk: Конфликты синхронизации" });
		contentEl.createEl("p", {
			text: `Обнаружено ${this.conflicts.length} конфликтов. Файлы были изменены и локально, и на Яндекс.Диске.`,
			cls: "obsyadisk-conflict-description",
		});

		const listEl = contentEl.createDiv({ cls: "obsyadisk-conflict-list" });

		for (const conflict of this.conflicts) {
			if (conflict.type !== "conflict") continue;

			const itemEl = listEl.createDiv({ cls: "obsyadisk-conflict-item" });

			const infoEl = itemEl.createDiv({ cls: "obsyadisk-conflict-info" });
			infoEl.createEl("strong", { text: conflict.path });

			const timesEl = infoEl.createDiv({ cls: "obsyadisk-conflict-times" });
			timesEl.createEl("span", {
				text: `Локально: ${new Date(conflict.localModified).toLocaleString()}`,
			});
			timesEl.createEl("span", { text: " | " });
			timesEl.createEl("span", {
				text: `Удалённо: ${new Date(conflict.remoteModified).toLocaleString()}`,
			});

			const buttonsEl = itemEl.createDiv({ cls: "obsyadisk-conflict-buttons" });

			new ButtonComponent(buttonsEl)
				.setButtonText("Оставить локальную")
				.setClass("mod-cta")
				.onClick(async () => {
					await this.syncEngine.resolveConflict(conflict.path, "local");
					itemEl.addClass("obsyadisk-resolved");
					itemEl.createEl("span", {
						text: " ✓ Локальная версия сохранена",
						cls: "obsyadisk-resolved-label",
					});
					this.checkAllResolved();
				});

			new ButtonComponent(buttonsEl)
				.setButtonText("Взять с Яндекс.Диска")
				.onClick(async () => {
					await this.syncEngine.resolveConflict(conflict.path, "remote");
					itemEl.addClass("obsyadisk-resolved");
					itemEl.createEl("span", {
						text: " ✓ Удалённая версия загружена",
						cls: "obsyadisk-resolved-label",
					});
					this.checkAllResolved();
				});
		}

		// Bulk actions
		const bulkEl = contentEl.createDiv({ cls: "obsyadisk-conflict-bulk" });
		bulkEl.createEl("h3", { text: "Массовые действия" });

		new ButtonComponent(bulkEl)
			.setButtonText("Все — оставить локальные")
			.onClick(async () => {
				for (const c of this.conflicts) {
					if (c.type === "conflict") {
						await this.syncEngine.resolveConflict(c.path, "local");
					}
				}
				this.close();
				this.onComplete();
			});

		new ButtonComponent(bulkEl)
			.setButtonText("Все — взять с Яндекс.Диска")
			.setWarning()
			.onClick(async () => {
				for (const c of this.conflicts) {
					if (c.type === "conflict") {
						await this.syncEngine.resolveConflict(c.path, "remote");
					}
				}
				this.close();
				this.onComplete();
			});
	}

	private checkAllResolved() {
		const unresolvedItems = this.contentEl.querySelectorAll(
			".obsyadisk-conflict-item:not(.obsyadisk-resolved)"
		);
		if (unresolvedItems.length === 0) {
			this.close();
			this.onComplete();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
