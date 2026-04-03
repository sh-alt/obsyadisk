import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { YaDiskResource, YaDiskUploadResponse } from "./types";

const API_BASE = "https://cloud-api.yandex.net/v1/disk";

export class YandexDiskClient {
	private token: string;

	constructor(token: string) {
		this.token = token;
	}

	setToken(token: string) {
		this.token = token;
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `OAuth ${this.token}`,
		};
	}

	private async request(
		method: string,
		url: string,
		body?: string | ArrayBuffer,
		extraHeaders?: Record<string, string>
	): Promise<RequestUrlResponse> {
		const params: RequestUrlParam = {
			url,
			method,
			headers: { ...this.headers(), ...(extraHeaders || {}) },
			body: body as any,
			throw: false,
		};
		return requestUrl(params);
	}

	/** Get resource metadata (file or directory). Returns null if not found. */
	async getResource(path: string, limit = 1000, offset = 0): Promise<YaDiskResource | null> {
		const url = `${API_BASE}/resources?path=${encodeURIComponent(path)}&limit=${limit}&offset=${offset}`;
		const resp = await this.request("GET", url);
		if (resp.status === 404) return null;
		if (resp.status !== 200) {
			throw new Error(`Yandex.Disk API error ${resp.status}: ${resp.text}`);
		}
		return resp.json as YaDiskResource;
	}

	/** List all files in a directory recursively */
	async listAllFiles(remotePath: string): Promise<YaDiskResource[]> {
		const files: YaDiskResource[] = [];
		const stack: string[] = [remotePath];

		while (stack.length > 0) {
			const dir = stack.pop()!;
			let offset = 0;
			let hasMore = true;

			while (hasMore) {
				const resource = await this.getResource(dir, 1000, offset);
				if (!resource || !resource._embedded) break;

				for (const item of resource._embedded.items) {
					if (item.type === "dir") {
						stack.push(item.path);
					} else {
						files.push(item);
					}
				}

				offset += resource._embedded.limit;
				hasMore = offset < resource._embedded.total;
			}
		}

		return files;
	}

	/** Create a directory (and parents) on Yandex.Disk */
	async mkdir(path: string): Promise<void> {
		const url = `${API_BASE}/resources?path=${encodeURIComponent(path)}`;
		const resp = await this.request("PUT", url);
		if (resp.status === 409) {
			// Already exists or parent missing – try creating parent
			const parent = path.replace(/\/[^/]+\/?$/, "");
			if (parent && parent !== path) {
				await this.mkdir(parent);
				const retry = await this.request("PUT", url);
				if (retry.status !== 201 && retry.status !== 409) {
					throw new Error(`mkdir failed ${retry.status}: ${retry.text}`);
				}
			}
		} else if (resp.status !== 201) {
			throw new Error(`mkdir failed ${resp.status}: ${resp.text}`);
		}
	}

	/** Get upload URL for a file */
	async getUploadUrl(path: string, overwrite = true): Promise<string> {
		const url = `${API_BASE}/resources/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite}`;
		const resp = await this.request("GET", url);
		if (resp.status !== 200) {
			throw new Error(`getUploadUrl failed ${resp.status}: ${resp.text}`);
		}
		const data = resp.json as YaDiskUploadResponse;
		return data.href;
	}

	/** Upload file content to Yandex.Disk */
	async uploadFile(remotePath: string, content: ArrayBuffer): Promise<void> {
		// Ensure parent directory exists
		const parentDir = remotePath.replace(/\/[^/]+$/, "");
		if (parentDir) {
			await this.mkdir(parentDir);
		}

		const uploadUrl = await this.getUploadUrl(remotePath, true);
		const resp = await this.request("PUT", uploadUrl, content, {
			"Content-Type": "application/octet-stream",
		});
		if (resp.status !== 201 && resp.status !== 202) {
			throw new Error(`Upload failed ${resp.status}: ${resp.text}`);
		}
	}

	/** Download file content from Yandex.Disk */
	async downloadFile(remotePath: string): Promise<ArrayBuffer> {
		const url = `${API_BASE}/resources/download?path=${encodeURIComponent(remotePath)}`;
		const resp = await this.request("GET", url);
		if (resp.status !== 200) {
			throw new Error(`getDownloadUrl failed ${resp.status}: ${resp.text}`);
		}
		const downloadUrl = (resp.json as { href: string }).href;
		const fileResp = await requestUrl({ url: downloadUrl, method: "GET" });
		return fileResp.arrayBuffer;
	}

	/** Delete a resource on Yandex.Disk */
	async deleteResource(path: string, permanently = false): Promise<void> {
		const url = `${API_BASE}/resources?path=${encodeURIComponent(path)}&permanently=${permanently}`;
		const resp = await this.request("DELETE", url);
		if (resp.status !== 204 && resp.status !== 202 && resp.status !== 404) {
			throw new Error(`Delete failed ${resp.status}: ${resp.text}`);
		}
	}

	/** Check if token is valid */
	async checkToken(): Promise<boolean> {
		const url = `${API_BASE}/`;
		const resp = await this.request("GET", url);
		return resp.status === 200;
	}
}
