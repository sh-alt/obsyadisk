import { App, Modal } from "obsidian";
import { diffLines, createTwoFilesPatch, Change } from "diff";

type ViewMode = "split" | "unified";

interface SplitLine {
	left: string | null;
	right: string | null;
	type: "added" | "removed" | "changed" | "unchanged";
}

export class DiffModal extends Modal {
	private filepath: string;
	private sha: string;
	private oldText: string;
	private newText: string;
	private leftLabel: string;
	private rightLabel: string;
	private mode: ViewMode = "split";

	constructor(
		app: App,
		filepath: string,
		sha: string,
		oldText: string,
		newText: string,
		leftLabel?: string,
		rightLabel?: string
	) {
		super(app);
		this.filepath = filepath;
		this.sha = sha;
		this.oldText = oldText;
		this.newText = newText;
		this.leftLabel = leftLabel ?? `${filepath} (коммит ${sha.slice(0, 8)})`;
		this.rightLabel = rightLabel ?? `${filepath} (текущая)`;
	}

	onOpen() {
		this.modalEl.addClass("obsyadisk-diff-modal-wide");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		// Header
		contentEl.createEl("h2", { text: `Diff: ${this.filepath}` });

		const meta = contentEl.createDiv({ cls: "obsyadisk-diff-meta" });
		meta.createEl("span", {
			text: `${this.leftLabel} → ${this.rightLabel}`,
			cls: "obsyadisk-diff-subtitle",
		});

		// Toggle button
		const toggleBtn = meta.createEl("button", {
			text: this.mode === "split" ? "Переключить на unified" : "Переключить на split",
			cls: "obsyadisk-diff-toggle",
		});
		toggleBtn.onclick = () => {
			this.mode = this.mode === "split" ? "unified" : "split";
			this.render();
		};

		// Diff content
		if (this.mode === "split") {
			this.renderSplit(contentEl);
		} else {
			this.renderUnified(contentEl);
		}
	}

	private renderSplit(container: HTMLElement) {
		const changes = diffLines(this.oldText, this.newText);
		const lines = this.buildSplitLines(changes);

		const wrapper = container.createDiv({ cls: "obsyadisk-diff-split-wrapper" });
		const table = wrapper.createEl("table", { cls: "obsyadisk-diff-split-table" });

		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		headerRow.createEl("th", { text: "#", cls: "obsyadisk-diff-lnum" });
		headerRow.createEl("th", { text: this.leftLabel });
		headerRow.createEl("th", { text: "#", cls: "obsyadisk-diff-lnum" });
		headerRow.createEl("th", { text: this.rightLabel });

		const tbody = table.createEl("tbody");
		let leftNum = 1;
		let rightNum = 1;

		for (const line of lines) {
			const tr = tbody.createEl("tr");

			if (line.type === "unchanged") {
				tr.createEl("td", { text: String(leftNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.left ?? "", cls: "obsyadisk-diff-cell" });
				tr.createEl("td", { text: String(rightNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.right ?? "", cls: "obsyadisk-diff-cell" });
			} else if (line.type === "removed") {
				tr.addClass("obsyadisk-diff-row-del");
				tr.createEl("td", { text: String(leftNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.left ?? "", cls: "obsyadisk-diff-cell" });
				tr.createEl("td", { text: "", cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: "", cls: "obsyadisk-diff-cell obsyadisk-diff-empty" });
			} else if (line.type === "added") {
				tr.addClass("obsyadisk-diff-row-add");
				tr.createEl("td", { text: "", cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: "", cls: "obsyadisk-diff-cell obsyadisk-diff-empty" });
				tr.createEl("td", { text: String(rightNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.right ?? "", cls: "obsyadisk-diff-cell" });
			} else {
				// changed — both sides have content, highlighted differently
				tr.createEl("td", { text: String(leftNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.left ?? "", cls: "obsyadisk-diff-cell obsyadisk-diff-cell-del" });
				tr.createEl("td", { text: String(rightNum++), cls: "obsyadisk-diff-lnum" });
				tr.createEl("td", { text: line.right ?? "", cls: "obsyadisk-diff-cell obsyadisk-diff-cell-add" });
			}
		}
	}

	private buildSplitLines(changes: Change[]): SplitLine[] {
		const result: SplitLine[] = [];
		let removedBuffer: string[] = [];

		const flushRemoved = () => {
			for (const line of removedBuffer) {
				result.push({ left: line, right: null, type: "removed" });
			}
			removedBuffer = [];
		};

		for (const change of changes) {
			const raw = change.value.split("\n");
			if (raw[raw.length - 1] === "") raw.pop();

			if (change.removed) {
				removedBuffer.push(...raw);
			} else if (change.added) {
				// Pair with removedBuffer line by line
				const maxLen = Math.max(removedBuffer.length, raw.length);
				for (let i = 0; i < maxLen; i++) {
					const left = removedBuffer[i] ?? null;
					const right = raw[i] ?? null;
					if (left !== null && right !== null) {
						result.push({ left, right, type: "changed" });
					} else if (left !== null) {
						result.push({ left, right: null, type: "removed" });
					} else {
						result.push({ left: null, right, type: "added" });
					}
				}
				removedBuffer = [];
			} else {
				flushRemoved();
				for (const line of raw) {
					result.push({ left: line, right: line, type: "unchanged" });
				}
			}
		}
		flushRemoved();
		return result;
	}

	private renderUnified(container: HTMLElement) {
		const patch = createTwoFilesPatch(
			this.leftLabel,
			this.rightLabel,
			this.oldText,
			this.newText
		);

		const pre = container.createEl("pre", { cls: "obsyadisk-diff-view" });

		for (const line of patch.split("\n")) {
			const span = pre.createEl("span");
			span.setText(line + "\n");
			if (line.startsWith("+") && !line.startsWith("+++")) span.addClass("obsyadisk-diff-add");
			else if (line.startsWith("-") && !line.startsWith("---")) span.addClass("obsyadisk-diff-del");
			else if (line.startsWith("@@")) span.addClass("obsyadisk-diff-hunk");
			else if (line.startsWith("---") || line.startsWith("+++")) span.addClass("obsyadisk-diff-header");
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
