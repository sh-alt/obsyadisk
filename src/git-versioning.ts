import git from "isomorphic-git";
import { Vault, normalizePath as obsNormalize } from "obsidian";
import { formatDate } from "./utils";

/**
 * Git-based versioning for vault files.
 * Uses isomorphic-git with a custom fs adapter backed by Obsidian's Vault API.
 */
export class GitVersioning {
	private vault: Vault;
	private gitDir: string;
	private fs: GitFsAdapter;

	constructor(vault: Vault) {
		this.vault = vault;
		this.gitDir = ".obsyadisk-git";
		this.fs = new GitFsAdapter(vault);
	}

	/** Initialize git repo inside the vault (hidden directory) */
	async init(): Promise<void> {
		// Ensure git dir exists
		const dirPath = obsNormalize(this.gitDir);
		if (!(await this.vault.adapter.exists(dirPath))) {
			await this.vault.adapter.mkdir(dirPath);
		}

		try {
			await git.init({
				fs: this.fs,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				defaultBranch: "main",
			});
		} catch (e: any) {
			// Already initialized
			if (!e.message?.includes("already exists")) {
				throw e;
			}
		}
	}

	/** Stage all changed vault files and create a commit */
	async commitAll(messageTemplate: string): Promise<string | null> {
		await this.init(); // ensure repo is initialized before every commit
		const message = messageTemplate.replace("{{date}}", formatDate(new Date()));

		// Get all vault files (excluding our git dir and .obsidian internals that are excluded)
		const files = this.vault.getFiles();

		for (const file of files) {
			if (file.path.startsWith(this.gitDir)) continue;

			try {
				const content = await this.vault.readBinary(file);
				// Write to git index
				await git.add({
					fs: this.fs,
					dir: "/",
					gitdir: `/${this.gitDir}`,
					filepath: file.path,
				});
			} catch (e) {
				console.warn(`ObsYaDisk: Could not stage ${file.path}:`, e);
			}
		}

		// Check if there's anything to commit
		const status = await this.getChangedFiles();
		if (status.length === 0) return null;

		const sha = await git.commit({
			fs: this.fs,
			dir: "/",
			gitdir: `/${this.gitDir}`,
			message,
			author: {
				name: "ObsYaDisk",
				email: "obsyadisk@local",
			},
		});

		return sha;
	}

	/** Get list of files with uncommitted changes */
	async getChangedFiles(): Promise<Array<{ path: string; status: string }>> {
		const changed: Array<{ path: string; status: string }> = [];

		try {
			const matrix = await git.statusMatrix({
				fs: this.fs,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				filter: (f: string) => !f.startsWith(this.gitDir),
			});

			for (const [filepath, head, workdir, stage] of matrix) {
				// [filepath, HEAD, WORKDIR, STAGE]
				// 1 = exists, 0 = doesn't exist
				if (head !== workdir || head !== stage) {
					let status = "modified";
					if (head === 0) status = "added";
					if (workdir === 0) status = "deleted";
					changed.push({ path: filepath as string, status });
				}
			}
		} catch (e) {
			// No commits yet, all files are new
			const files = this.vault.getFiles();
			for (const f of files) {
				if (!f.path.startsWith(this.gitDir)) {
					changed.push({ path: f.path, status: "added" });
				}
			}
		}

		return changed;
	}

	/** Get commit log */
	async getLog(depth = 20): Promise<Array<{ sha: string; message: string; date: Date }>> {
		try {
			const commits = await git.log({
				fs: this.fs,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				depth,
			});

			return commits.map((c) => ({
				sha: c.oid,
				message: c.commit.message,
				date: new Date(c.commit.author.timestamp * 1000),
			}));
		} catch {
			return [];
		}
	}

	/** Get file content at a specific commit */
	async getFileAtCommit(filepath: string, sha: string): Promise<Uint8Array | null> {
		try {
			const result = await git.readBlob({
				fs: this.fs,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				oid: sha,
				filepath,
			});
			return result.blob;
		} catch {
			return null;
		}
	}

	/** Restore a file to a specific commit version */
	async restoreFile(filepath: string, sha: string): Promise<boolean> {
		const content = await this.getFileAtCommit(filepath, sha);
		if (!content) return false;

		const normalized = obsNormalize(filepath);
		await this.vault.adapter.writeBinary(normalized, content.buffer as ArrayBuffer);
		return true;
	}
}

/**
 * Adapter that maps isomorphic-git's fs calls to Obsidian's Vault adapter.
 * isomorphic-git expects a subset of Node's fs API.
 */
class GitFsAdapter {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	get promises() {
		return {
			readFile: async (path: string, options?: any): Promise<Uint8Array | string> => {
				const p = this.clean(path);
				const data = await this.vault.adapter.readBinary(p);
				const arr = new Uint8Array(data);
				if (options?.encoding === "utf8") return new TextDecoder().decode(arr);
				return arr;
			},

			writeFile: async (path: string, data: any, options?: any): Promise<void> => {
				const p = this.clean(path);
				const dir = p.replace(/\/[^/]+$/, "");
				if (dir && !(await this.vault.adapter.exists(dir))) {
					await this.mkdirp(dir);
				}
				if (typeof data === "string") {
					await this.vault.adapter.write(p, data);
				} else {
					const buf = data instanceof Uint8Array ? data.buffer : data;
					await this.vault.adapter.writeBinary(p, buf as ArrayBuffer);
				}
			},

			mkdir: async (path: string, options?: any): Promise<void> => {
				const p = this.clean(path);
				if (!(await this.vault.adapter.exists(p))) {
					await this.vault.adapter.mkdir(p);
				}
			},

			rmdir: async (path: string, options?: any): Promise<void> => {
				const p = this.clean(path);
				await this.vault.adapter.rmdir(p, true);
			},

			unlink: async (path: string): Promise<void> => {
				const p = this.clean(path);
				if (await this.vault.adapter.exists(p)) {
					await this.vault.adapter.remove(p);
				}
			},

			stat: async (path: string): Promise<any> => {
				const p = this.clean(path);
				const stat = await this.vault.adapter.stat(p);
				if (!stat) throw new Error(`ENOENT: ${p}`);
				return {
					isFile: () => stat.type === "file",
					isDirectory: () => stat.type === "folder",
					isSymbolicLink: () => false,
					size: stat.size,
					mtimeMs: stat.mtime,
					mode: stat.type === "folder" ? 0o40755 : 0o100644,
				};
			},

			lstat: async (path: string): Promise<any> => {
				return this.promises.stat(path);
			},

			readdir: async (path: string): Promise<string[]> => {
				const p = this.clean(path);
				const list = await this.vault.adapter.list(p);
				const entries: string[] = [];
				for (const f of list.files) {
					const name = f.split("/").pop();
					if (name) entries.push(name);
				}
				for (const d of list.folders) {
					const name = d.split("/").pop();
					if (name) entries.push(name);
				}
				return entries;
			},

			readlink: async (path: string): Promise<string> => {
				throw new Error("Symlinks not supported");
			},

			symlink: async (target: string, path: string): Promise<void> => {
				throw new Error("Symlinks not supported");
			},

			chmod: async (path: string, mode: number): Promise<void> => {
				// no-op
			},

			rename: async (oldPath: string, newPath: string): Promise<void> => {
				const op = this.clean(oldPath);
				const np = this.clean(newPath);
				const data = await this.vault.adapter.readBinary(op);
				await this.vault.adapter.writeBinary(np, data);
				await this.vault.adapter.remove(op);
			},
		};
	}

	private clean(path: string): string {
		// Remove leading slash for Obsidian vault paths
		return path.replace(/^\/+/, "");
	}

	private async mkdirp(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.vault.adapter.exists(current))) {
				await this.vault.adapter.mkdir(current);
			}
		}
	}
}
