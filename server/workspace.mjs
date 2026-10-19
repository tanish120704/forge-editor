import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const ignored = new Set(['node_modules', '.git', '.local-data', 'dist', '.DS_Store', '.venv']);
export class Workspace {
  constructor(root) { this.root = path.resolve(root); this.pending = new Map(); }
  async init() { this.root = await fs.realpath(this.root); if (!(await fs.stat(this.root)).isDirectory()) throw new Error('Choose a folder.'); return this; }
  async resolve(relative = '', create = false) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid workspace path.');
    const candidate = path.resolve(this.root, relative);
    const inside = p => p === this.root || p.startsWith(this.root + path.sep);
    if (!inside(candidate)) throw new Error('Path is outside the workspace.');
    const real = create ? path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate)) : await fs.realpath(candidate);
    if (!inside(real)) throw new Error('Symlink points outside the workspace.');
    return real;
  }
  async tree(relative = '') {
    const dir = await this.resolve(relative);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => !ignored.has(e.name) && !e.isSymbolicLink()).map(e => ({ name: e.name, path: path.posix.join(relative, e.name), type: e.isDirectory() ? 'directory' : 'file' })).sort((a,b) => (b.type === 'directory') - (a.type === 'directory') || a.name.localeCompare(b.name));
  }
  async read(relative) {
    const filename = await this.resolve(relative), stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error('Choose a regular text file.');
    if (stat.size > 4 * 1024 * 1024) throw new Error('This editor opens text files up to 4 MB.');
    const data = await fs.readFile(filename);
    if (data.includes(0)) throw new Error('Binary files cannot be edited as text.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { path: relative, content, revision: digest(data), bytes: data.length };
  }
  async write(relative, content, revision, create = false) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Invalid file content or file larger than 4 MB.');
    // Serialize writes to each path so concurrent saves cannot pass the same revision check.
    const previous = this.pending.get(relative) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const filename = await this.resolve(relative, create);
      if (create) { await fs.writeFile(filename, content, { flag: 'wx' }); return { revision: digest(content) }; }
      const current = await fs.readFile(filename);
      if (digest(current) !== revision) { const error = new Error('File changed on disk. Reopen it before saving to avoid overwriting another edit.'); error.status = 409; throw error; }
      const stat = await fs.stat(filename);
      const temp = path.join(path.dirname(filename), `.forge-save-${crypto.randomUUID()}`);
      try { await fs.writeFile(temp, content, { mode: stat.mode }); await fs.rename(temp, filename); }
      finally { await fs.rm(temp, { force: true }); }
      return { revision: digest(content) };
    });
    this.pending.set(relative, task);
    try { return await task; } finally { if (this.pending.get(relative) === task) this.pending.delete(relative); }
  }
  async files() {
    const files = []; let truncated = false;
    const visit = async (dir, depth = 0) => {
      if (depth > 20 || files.length >= 3000) { truncated = true; return; }
      for (const item of await this.tree(dir)) {
        if (files.length >= 3000) { truncated = true; break; }
        if (item.type === 'directory') await visit(item.path, depth + 1); else files.push(item.path);
      }
    };
    await visit(''); return { files, truncated };
  }
  async search(query, caseSensitive = false) {
    if (!query || query.length > 200) return { matches: [], truncated: false };
    const inventory = await this.files(), matches = []; let skipped = 0;
    const needle = caseSensitive ? query : query.toLowerCase();
    for (const file of inventory.files) {
      if (matches.length >= 300) break;
      let content;
      try { content = (await this.read(file)).content; } catch { skipped++; continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 300; i++) {
        const column = (caseSensitive ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
        if (column !== -1) matches.push({ path: file, line: i + 1, column: column + 1, preview: lines[i].slice(0, 240) });
      }
    }
    return { matches, skipped, truncated: inventory.truncated || matches.length >= 300 };
  }
}
