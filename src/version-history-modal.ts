import { App, Modal, Notice, ButtonComponent } from "obsidian";
import { GitVersioning } from "./git-versioning";
import { DiffModal } from "./diff-modal";

type LogEntry = { sha: string; message: string; date: Date };
type ChangedFile = { path: string; status: "added" | "modified" | "deleted" };

/** How many commits to fetch for the general (vault-wide) log before day-grouping */
const GENERAL_LOG_DEPTH = 300;

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

		// Per-file history is usually short; the general log can be long, especially
		// with debounced sync-on-change, so fetch deeper for meaningful day grouping.
		const logDepth = this.filePath ? 50 : GENERAL_LOG_DEPTH;
		const log = await this.git.getLog(logDepth);

		if (log.length === 0) {
			contentEl.createEl("p", { text: "История пуста. Выполните синхронизацию для создания первого коммита." });
			return;
		}

		const listEl = contentEl.createDiv({ cls: "obsyadisk-version-list" });

		if (this.filePath) {
			// Flat chronological list — a single file's history is usually short enough
			// that day-grouping would just add friction without helping.
			for (const entry of log) {
				this.renderCommitItem(listEl, entry);
			}
			return;
		}

		// General (vault-wide) history: group by local calendar day, day-summary first,
		// per-commit breakdown available as an optional toggle.
		for (const dayEntries of this.groupByDay(log)) {
			this.renderDayGroup(listEl, dayEntries);
		}

		// log.length hitting the fetch cap means there's more history beyond it — the
		// oldest day shown above may only have its tail end of commits included, so its
		// commit count and per-commit breakdown could be undercounted. The day-summary
		// diff itself is unaffected (it walks git objects directly via getParentSha, not
		// this list), so only the count/breakdown honesty note is needed here.
		if (log.length === logDepth) {
			contentEl.createEl("p", {
				text: `Показаны последние ${logDepth} коммитов — самый старый день в списке выше может быть неполным.`,
				cls: "obsyadisk-version-meta",
			});
		}
	}

	/** Group log entries (already newest-first) into day-buckets, preserving that order */
	private groupByDay(log: LogEntry[]): LogEntry[][] {
		const map = new Map<string, LogEntry[]>();
		for (const entry of log) {
			const key = `${entry.date.getFullYear()}-${entry.date.getMonth()}-${entry.date.getDate()}`;
			const bucket = map.get(key);
			if (bucket) bucket.push(entry);
			else map.set(key, [entry]);
		}
		return Array.from(map.values());
	}

	private renderDayGroup(container: HTMLElement, dayEntries: LogEntry[]) {
		const dayEl = container.createDiv({ cls: "obsyadisk-version-day" });
		const headerEl = dayEl.createDiv({ cls: "obsyadisk-version-day-header" });

		const dateLabel = dayEntries[0].date.toLocaleDateString(undefined, {
			day: "numeric",
			month: "long",
			year: "numeric",
		});
		headerEl.createEl("strong", { text: dateLabel });
		headerEl.createEl("span", {
			text: ` — ${dayEntries.length} ${this.commitWord(dayEntries.length)}`,
			cls: "obsyadisk-version-meta",
		});

		const bodyEl = dayEl.createDiv({ cls: "obsyadisk-version-day-body" });
		const newestSha = dayEntries[0].sha;
		const oldestSha = dayEntries[dayEntries.length - 1].sha;

		new ButtonComponent(bodyEl).setButtonText("Изменения за день").onClick(async () => {
			const existing = bodyEl.querySelector(".obsyadisk-day-summary");
			if (existing) {
				const el = existing as HTMLElement;
				el.style.display = el.style.display === "none" ? "" : "none";
				return;
			}
			// Create the guard element synchronously, before any await, so a second
			// click while this is still loading finds it and toggles instead of
			// re-entering and building a duplicate summary block.
			const summaryEl = bodyEl.createDiv({ cls: "obsyadisk-commit-files obsyadisk-day-summary" });
			summaryEl.setText("Загрузка...");
			const fromSha = await this.git.getParentSha(oldestSha);
			const changed = await this.git.getChangesBetween(fromSha, newestSha);
			summaryEl.empty();
			if (changed.length === 0) {
				summaryEl.setText("Нет изменений файлов за этот день");
				return;
			}
			for (const f of changed) {
				this.renderChangedFileRow(
					summaryEl,
					f,
					fromSha,
					newestSha,
					`${f.path} (до этого дня)`,
					`${f.path} (на конец дня, ${dateLabel})`
				);
			}
		});

		// A single-commit day would show an identical breakdown — skip the redundant toggle.
		if (dayEntries.length > 1) {
			let commitsEl: HTMLElement | null = null;
			new ButtonComponent(bodyEl).setButtonText(`По коммитам (${dayEntries.length})`).onClick(() => {
				if (commitsEl) {
					commitsEl.style.display = commitsEl.style.display === "none" ? "" : "none";
					return;
				}
				commitsEl = bodyEl.createDiv({ cls: "obsyadisk-version-day-commits" });
				for (const entry of dayEntries) {
					this.renderCommitItem(commitsEl, entry);
				}
			});
		}
	}

	private commitWord(n: number): string {
		const mod10 = n % 10;
		const mod100 = n % 100;
		if (mod10 === 1 && mod100 !== 11) return "коммит";
		if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "коммита";
		return "коммитов";
	}

	private renderCommitItem(container: HTMLElement, entry: LogEntry) {
		const itemEl = container.createDiv({ cls: "obsyadisk-version-item" });

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
		new ButtonComponent(itemEl).setButtonText("Файлы").onClick(async () => {
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
			const parentSha = await this.git.getParentSha(entry.sha);
			for (const f of changed) {
				this.renderChangedFileRow(
					filesEl,
					f,
					parentSha,
					entry.sha,
					`${f.path} (до коммита)`,
					`${f.path} (в коммите ${entry.sha.slice(0, 8)})`
				);
			}
		});
	}

	/** One changed-file row with a Diff button comparing fromSha -> toSha for that file */
	private renderChangedFileRow(
		container: HTMLElement,
		f: ChangedFile,
		fromSha: string | null,
		toSha: string,
		leftLabel: string,
		rightLabel: string
	) {
		const icon = f.status === "added" ? "+" : f.status === "deleted" ? "−" : "~";
		const cls = f.status === "added"
			? "obsyadisk-file-added"
			: f.status === "deleted"
			? "obsyadisk-file-deleted"
			: "obsyadisk-file-modified";
		const row = container.createDiv({ cls: `obsyadisk-commit-file-row ${cls}` });
		row.createEl("code", { text: `${icon} ${f.path}` });
		new ButtonComponent(row)
			.setButtonText("Diff")
			.setClass("obsyadisk-commit-file-diff-btn")
			.onClick(async () => {
				const result = await this.git.getFileDiffBetween(f.path, fromSha, toSha);
				if (!result) {
					new Notice("ObsYaDisk: Не удалось получить diff (бинарный файл или файл отсутствует)");
					return;
				}
				new DiffModal(this.app, f.path, toSha, result.oldText, result.newText, leftLabel, rightLabel).open();
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}
