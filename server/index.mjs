import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { Workspace } from './workspace.mjs';
const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ttf':'font/ttf', '.woff2':'font/woff2', '.json':'application/json' };
export async function startServer({ root = path.join(project, 'sample-workspace'), port = 0, dev = false } = {}) {
  let workspace = await new Workspace(root).init();
  const token = crypto.randomBytes(32).toString('hex'), terminals = new Set();
  const vite = dev ? await (await import('vite')).createServer({ root: project, server: { middlewareMode:true }, appType:'spa' }) : null;
  let origin;
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(value)); };
  const readBody = async req => {
    let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 6 * 1024 * 1024) throw new Error('Request too large.'); }
    return JSON.parse(body || '{}');
  };
  const changeRoot = async root => {
    workspace = await new Workspace(root).init();
    for (const term of terminals) { term.socket.close(1000, 'Workspace changed'); term.child.kill(); }
    return { root: workspace.root, name: path.basename(workspace.root) };
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error:'Invalid host.' });
      const url = new URL(req.url, origin);
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error:'Cross-origin requests are not allowed.' });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error:'Open the editor using its launch URL.' });
        const body = req.method === 'GET' ? {} : await readBody(req);
        let result;
        if (url.pathname === '/api/workspace' && req.method === 'GET') result = { root:workspace.root, name:path.basename(workspace.root) };
        else if (url.pathname === '/api/workspace' && req.method === 'POST') result = await changeRoot(body.root);
        else if (url.pathname === '/api/tree' && req.method === 'GET') result = await workspace.tree(url.searchParams.get('path') || '');
        else if (url.pathname === '/api/files' && req.method === 'GET') result = await workspace.files();
        else if (url.pathname === '/api/file' && req.method === 'GET') result = await workspace.read(url.searchParams.get('path'));
        else if (url.pathname === '/api/file' && req.method === 'PUT') result = await workspace.write(body.path, body.content, body.revision);
        else if (url.pathname === '/api/file' && req.method === 'POST') result = await workspace.write(body.path, body.content || '', null, true);
        else if (url.pathname === '/api/search' && req.method === 'GET') result = await workspace.search(url.searchParams.get('q'), url.searchParams.get('case') === 'true');
        else if (url.pathname === '/api/git' && req.method === 'GET') {
          try {
            const opts = { cwd:workspace.root, timeout:5000, maxBuffer:1024 * 1024, env:{...process.env,GIT_OPTIONAL_LOCKS:'0'} };
            const [{stdout:status},{stdout:branch},{stdout:gitRoot}] = await Promise.all([exec('/usr/bin/git',['status','--porcelain=v1','-z','--untracked-files=all','--','.'],opts),exec('/usr/bin/git',['branch','--show-current'],opts),exec('/usr/bin/git',['rev-parse','--show-toplevel'],opts)]);
            const chunks = status.split('\0').filter(Boolean), changes = [];
            for (let i=0;i<chunks.length;i++) { const item = chunks[i], relative=path.relative(workspace.root,path.resolve(gitRoot.trim(),item.slice(3))); if(relative && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) changes.push({ status:item.slice(0,2).trim(), path:relative }); if (/[RC]/.test(item.slice(0,2))) i++; }
            result = { available:true, branch:branch.trim() || 'detached HEAD', changes };
          } catch { result = { available:false, changes:[] }; }
        } else return send(res, 404, { error:'Unknown operation.' });
        return send(res, 200, result);
      }
      if (vite) return vite.middlewares(req,res,()=>send(res,404,{error:'Not found.'}));
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = path.resolve(project, 'dist', '.' + relative);
      if (!target.startsWith(path.join(project, 'dist') + path.sep)) return send(res,403,{error:'Invalid path.'});
      const bytes = await fs.readFile(target);
      res.writeHead(200, { 'Content-Type':contentTypes[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'" });
      res.end(bytes);
    } catch (error) { send(res, error.status || 400, { error: error.code === 'ENOENT' ? 'File or folder not found.' : error.message }); }
  });
  const wss = new WebSocketServer({ noServer:true, maxPayload:256 * 1024 });
  server.on('upgrade', (req,socket,head) => {
    const url = new URL(req.url,origin);
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || url.pathname !== '/terminal' || url.searchParams.get('token') !== token || terminals.size >= 4) { socket.destroy(); return; }
    wss.handleUpgrade(req,socket,head,ws => wss.emit('connection',ws));
  });
  wss.on('connection', socket => {
    const child = spawn(process.env.FORGE_PYTHON || '/usr/bin/python3', ['-u', path.join(project,'server/terminal_bridge.py')], { cwd:workspace.root, env:process.env, stdio:['pipe','pipe','pipe'] });
    const item = {child,socket}; terminals.add(item); let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) !== -1) { const line=buffer.slice(0,index); buffer=buffer.slice(index+1); if (socket.readyState === 1) socket.send(line); } });
    child.stderr.on('data', chunk => { if (socket.readyState === 1) socket.send(JSON.stringify({type:'error',message:String(chunk)})); });
    child.on('error', error => { if (socket.readyState === 1) socket.send(JSON.stringify({type:'error',message:error.message})); socket.close(); });
    child.on('exit', () => { terminals.delete(item); socket.close(); });
    child.stdin.on('error', () => {});
    socket.on('message', data => { try { const m=JSON.parse(String(data)); if (m.type === 'input' && typeof m.data === 'string' || m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) child.stdin.write(JSON.stringify(m)+'\n'); } catch {} });
    socket.on('close', () => { child.kill(); terminals.delete(item); });
  });
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, url:`${origin}/#${token}`, changeRoot, async close() { for (const {child,socket} of terminals) { child.kill(); socket.terminate(); } wss.close(); await vite?.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--workspace');
  const instance = await startServer({ root:rootIndex !== -1 ? process.argv[rootIndex+1] : undefined, port:Number(process.env.PORT || 4173), dev:process.argv.includes('--dev') });
  console.log(`Forge editor: ${instance.url}`);
  process.on('SIGTERM', async()=>{await instance.close();process.exit(0);});
  process.on('SIGINT', async()=>{await instance.close();process.exit(0);});
}
