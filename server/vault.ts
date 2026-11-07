/**
 * Workspace (vault) file operations.
 *
 * A vault is a plain directory of documents — like Obsidian, no database. All
 * paths crossing this module are relative, POSIX-style, and validated to stay
 * inside the root.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FileContent, FileEntry, SavedFile, WorkspaceInfo } from '../shared/protocol';
import { allAdapters, languageOf } from './engine/registry';

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'target', '.typsidian']);
const TEXT_EXTENSIONS = new Set(['.typ', '.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.toml', '.csv']);

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(this.root).isDirectory()) {
      throw new Error(`vault root is not a directory: ${this.root}`);
    }
  }

  /** Absolute path for a vault-relative path, rejecting escapes. */
  resolve(relativePath: string): string {
    const cleaned = relativePath.replace(/^\/+/, '');
    const absolute = path.resolve(this.root, cleaned);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`path escapes the vault: ${relativePath}`);
    }
    return absolute;
  }

  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath).split(path.sep).join('/');
  }

  list(): FileEntry[] {
    const entries: FileEntry[] = [];
    const walk = (directory: string) => {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (child.name.startsWith('.')) continue;
        if (child.name.endsWith('~') || child.name.endsWith('.swp')) continue;
        const absolute = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(child.name)) continue;
          walk(absolute);
          continue;
        }
        if (!child.isFile()) continue;
        const extension = path.extname(child.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension)) continue;
        const stat = fs.statSync(absolute);
        entries.push({
          path: this.relative(absolute),
          name: child.name,
          language: languageOf(child.name),
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      }
    };
    walk(this.root);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  info(): WorkspaceInfo {
    return {
      root: this.root,
      title: path.basename(this.root),
      files: this.list(),
      languages: allAdapters().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        extensions: [...adapter.extensions],
      })),
    };
  }

  read(relativePath: string): FileContent {
    const absolute = this.resolve(relativePath);
    const source = fs.readFileSync(absolute, 'utf8');
    const stat = fs.statSync(absolute);
    return {
      path: this.relative(absolute),
      source,
      mtime: stat.mtimeMs,
      language: languageOf(absolute),
    };
  }

  write(relativePath: string, source: string): SavedFile {
    const absolute = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    const stat = fs.statSync(absolute);
    return { path: this.relative(absolute), mtime: stat.mtimeMs };
  }

  create(relativePath: string, source = ''): FileEntry {
    const absolute = this.resolve(relativePath);
    if (fs.existsSync(absolute)) {
      throw new Error(`file already exists: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    const stat = fs.statSync(absolute);
    return {
      path: this.relative(absolute),
      name: path.basename(absolute),
      language: languageOf(absolute),
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }

  rename(from: string, to: string): { from: string; to: string; entry: FileEntry } {
    const fromAbsolute = this.resolve(from);
    const toAbsolute = this.resolve(to);
    if (!fs.existsSync(fromAbsolute)) throw new Error(`file not found: ${from}`);
    fs.mkdirSync(path.dirname(toAbsolute), { recursive: true });
    fs.renameSync(fromAbsolute, toAbsolute);
    const stat = fs.statSync(toAbsolute);
    return {
      from: this.relative(fromAbsolute),
      to: this.relative(toAbsolute),
      entry: {
        path: this.relative(toAbsolute),
        name: path.basename(toAbsolute),
        language: languageOf(toAbsolute),
        mtime: stat.mtimeMs,
        size: stat.size,
      },
    };
  }

  remove(relativePath: string): void {
    const absolute = this.resolve(relativePath);
    fs.rmSync(absolute, { force: true });
  }

  /** Absolute path used by adapters. */
  absolute(relativePath: string): string {
    return this.resolve(relativePath);
  }
}
