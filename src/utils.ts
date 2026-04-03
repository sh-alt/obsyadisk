import * as SparkMD5 from "spark-md5";

/** Compute MD5 hash of an ArrayBuffer — result matches Yandex.Disk md5 field */
export function computeMd5Hex(buffer: ArrayBuffer): string {
	return SparkMD5.ArrayBuffer.hash(buffer);
}

/** Convert string to ArrayBuffer (UTF-8) */
export function stringToBuffer(str: string): ArrayBuffer {
	return new TextEncoder().encode(str).buffer;
}

/** Convert ArrayBuffer to string (UTF-8) */
export function bufferToString(buf: ArrayBuffer): string {
	return new TextDecoder().decode(buf);
}

/** Check if a path matches any of the exclude patterns (simple glob) */
export function isExcluded(filePath: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchGlob(filePath, pattern)) return true;
	}
	return false;
}

function matchGlob(str: string, pattern: string): boolean {
	// Convert glob to regex
	let regexStr = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				regexStr += ".*";
				i++; // skip second *
				if (pattern[i + 1] === "/") i++; // skip /
			} else {
				regexStr += "[^/]*";
			}
		} else if (c === "?") {
			regexStr += "[^/]";
		} else if (c === ".") {
			regexStr += "\\.";
		} else if (/[\\^$|+()[\]{}]/.test(c)) {
			regexStr += "\\" + c;
		} else {
			regexStr += c;
		}
	}
	regexStr += "$";
	return new RegExp(regexStr).test(str);
}

/** Format date for commit messages */
export function formatDate(date: Date): string {
	return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Normalize path separators to forward slash and remove leading slash */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Simple debounce */
export function debounce<T extends (...args: any[]) => any>(
	fn: T,
	delay: number
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (...args: Parameters<T>) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	};
}
