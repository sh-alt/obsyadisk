import git, { TREE } from "isomorphic-git";
import { createTwoFilesPatch } from "diff";
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
				fs: this.fs.promises,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				defaultBranch: "main",
			});
		} catch (e: any) {
			// Already initialized
			if (!e.message?.includes("already exists")) {
				console.error("ObsYaDisk: git.init() failed:", e);
				throw e;
			}
		}
	}

	/** Diagnostic: test each fs adapter operation step by step */
	async diagnose(): Promise<string[]> {
		const log: string[] = [];
		const adapter = this.vault.adapter;
		const gitDir = this.gitDir;

		try {
			// 1. Can we stat the vault root?
			const rootStat = await adapter.stat("/");
			log.push(`stat("/") → ${rootStat ? rootStat.type : "null"}`);
		} catch (e: any) {
			log.push(`stat("/") → ERROR: ${e.message}`);
		}

		try {
			// 2. Can we write a file into .obsyadisk-git?
			await adapter.write(`${gitDir}/HEAD`, "ref: refs/heads/main\n");
			log.push(`write("${gitDir}/HEAD") → OK`);
		} catch (e: any) {
			log.push(`write("${gitDir}/HEAD") → ERROR: ${e.message}`);
		}

		try {
			// 3. Can we read it back?
			const content = await adapter.read(`${gitDir}/HEAD`);
			log.push(`read("${gitDir}/HEAD") → "${content.trim()}"`);
		} catch (e: any) {
			log.push(`read("${gitDir}/HEAD") → ERROR: ${e.message}`);
		}

		try {
			// 4. Can we mkdir inside .obsyadisk-git?
			await adapter.mkdir(`${gitDir}/objects`);
			log.push(`mkdir("${gitDir}/objects") → OK`);
		} catch (e: any) {
			log.push(`mkdir("${gitDir}/objects") → ERROR: ${e.message}`);
		}

		try {
			// 5. Try full git.init()
			await git.init({ fs: this.fs.promises, dir: "/", gitdir: `/${gitDir}`, defaultBranch: "main" });
			log.push(`git.init() → OK`);
		} catch (e: any) {
			log.push(`git.init() → ERROR: ${e.message}`);
		}

		return log;
	}

	/** Stage all changed vault files and create a commit */
	async commitAll(messageTemplate: string): Promise<string | null> {
		await this.init(); // ensure repo is initialized before every commit
		const message = messageTemplate.replace("{{date}}", formatDate(new Date()));

		// Step 1: find which files changed in workdir vs HEAD (no file reads — uses index)
		let changedPaths: string[] = [];
		try {
			const matrix = await git.statusMatrix({
				fs: this.fs.promises,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				filter: (f: string) =>
					!f.startsWith(this.gitDir) &&
					!f.startsWith(".obsidian/") &&
					!f.startsWith(".trash/") &&
					!f.startsWith(".obsyadisk-"),
			});
			for (const [filepath, head, workdir] of matrix) {
				// workdir !== head → file added, modified, or deleted in workdir
				if (workdir !== head) {
					changedPaths.push(filepath as string);
				}
			}
		} catch {
			// No commits yet: treat all non-excluded files as changed
			changedPaths = this.vault
				.getFiles()
				.filter(
					f =>
						!f.path.startsWith(this.gitDir) &&
						!f.path.startsWith(".obsidian/") &&
						!f.path.startsWith(".trash/") &&
						!f.path.startsWith(".obsyadisk-")
				)
				.map(f => f.path);
		}

		if (changedPaths.length === 0) return null;

		// Step 2: git.add() only for the changed files
		for (const filepath of changedPaths) {
			try {
				await git.add({
					fs: this.fs.promises,
					dir: "/",
					gitdir: `/${this.gitDir}`,
					filepath,
				});
			} catch (e) {
				console.warn(`ObsYaDisk: Could not stage ${filepath}:`, e);
			}
		}

		// Step 3: verify something is actually staged (handles delete-only edge cases)
		const staged = await this.getChangedFiles();
		if (staged.length === 0) return null;

		const sha = await git.commit({
			fs: this.fs.promises,
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
				fs: this.fs.promises,
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
				fs: this.fs.promises,
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
				fs: this.fs.promises,
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

	/**
	 * Compute diff between file at a commit and its current state.
	 * Returns null if file is binary or not found.
	 */
	async getDiff(filepath: string, sha: string): Promise<{ oldText: string; newText: string } | null> {
		try {
			const oldBytes = await this.getFileAtCommit(filepath, sha);
			if (!oldBytes) return null;

			const decoder = new TextDecoder("utf-8");
			const oldText = decoder.decode(oldBytes);

			let newText = "";
			try {
				newText = await this.vault.adapter.read(obsNormalize(filepath));
			} catch {
				newText = "(файл удалён)";
			}

			return { oldText, newText };
		} catch {
			return null;
		}
	}

	/** Get list of files changed in a specific commit compared to its parent */
	async getCommitChangedFiles(sha: string): Promise<Array<{ path: string; status: "added" | "modified" | "deleted" }>> {
		try {
			const commit = await git.readCommit({
				fs: this.fs.promises,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				oid: sha,
			});

			const parentShas = commit.commit.parent;
			if (parentShas.length === 0) return [];

			const parentSha = parentShas[0];
			const results: Array<{ path: string; status: "added" | "modified" | "deleted" }> = [];

			await git.walk({
				fs: this.fs.promises,
				dir: "/",
				gitdir: `/${this.gitDir}`,
				trees: [TREE({ ref: parentSha }), TREE({ ref: sha })],
				map: async (filepath: string, entries: any[]) => {
					const [parent, current] = entries;
					if (filepath === ".") return true;
					if (current && (await current.type()) === "tree") return true;
					if (!parent && current) {
						results.push({ path: filepath, status: "added" });
					} else if (parent && !current) {
						results.push({ path: filepath, status: "deleted" });
					} else if (parent && current && (await parent.oid()) !== (await current.oid())) {
						results.push({ path: filepath, status: "modified" });
					}
					return null;
				},
			});

			return results;
		} catch {
			return [];
		}
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
					// Must slice to respect byteOffset/byteLength — data.buffer alone
					// returns the entire underlying ArrayBuffer regardless of the view offset,
					// which corrupts git binary files (index, pack, objects).
					let buf: ArrayBuffer;
					if (data instanceof Uint8Array) {
						buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
					} else {
						buf = data as ArrayBuffer;
					}
					await this.vault.adapter.writeBinary(p, buf);
				}
			},

			mkdir: async (path: string, options?: any): Promise<void> => {
				const p = this.clean(path);
				if (p) await this.mkdirp(p);
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
				// Root of vault always exists
				if (p === "") {
					return {
						isFile: () => false,
						isDirectory: () => true,
						isSymbolicLink: () => false,
						size: 0,
						mtimeMs: Date.now(),
						mode: 0o40755,
					};
				}
				const stat = await this.vault.adapter.stat(p);
				if (!stat) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				const now = Date.now();
				return {
					isFile: () => stat.type === "file",
					isDirectory: () => stat.type === "folder",
					isSymbolicLink: () => false,
					size: stat.size ?? 0,
					// Guard against undefined/null — isomorphic-git calls .valueOf() on these
					mtimeMs: stat.mtime ?? now,
					ctimeMs: stat.ctime ?? now,
					mode: stat.type === "folder" ? 0o40755 : 0o100644,
				};
			},

			lstat: async (path: string): Promise<any> => {
				return this.promises.stat(path);
			},

			readdir: async (path: string): Promise<string[]> => {
				const p = this.clean(path);
				const list = await this.vault.adapter.list(p || "/");
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
