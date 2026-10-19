#!/usr/bin/env python3
"""Package the already built editor with its installed Electron runtime."""
from pathlib import Path
import json, shutil, plistlib, subprocess

root = Path(__file__).resolve().parents[1]
destination = root.parent / 'Forge.app'
runtime = (root / 'node_modules/electron/dist/Electron.app').resolve()
if not (root / 'dist/index.html').exists():
    raise SystemExit('Build the frontend first: npm run build')
if destination.exists():
    raise SystemExit('Forge.app already exists. Move it aside before repackaging.')
shutil.copytree(runtime, destination, symlinks=True)
resources = destination / 'Contents/Resources'
(resources / 'default_app.asar').unlink(missing_ok=True)
app = resources / 'app'
app.mkdir()
for name in ['dist', 'server', 'electron', 'sample-workspace', 'licenses']:
    shutil.copytree(root / name, app / name, ignore=shutil.ignore_patterns('__pycache__'))
package = json.loads((root / 'package.json').read_text())
package['name'] = 'Forge'
package['productName'] = 'Forge'
package.pop('devDependencies', None)
package['dependencies'] = {'ws': package['dependencies']['ws']}
(app / 'package.json').write_text(json.dumps(package, indent=2))
shutil.copytree((root / 'node_modules/ws').resolve(), app / 'node_modules/ws')
for name in ['README.md', 'THIRD_PARTY_NOTICES.md']:
    if (root / name).exists(): shutil.copy(root / name, app / name)
plist_path = destination / 'Contents/Info.plist'
with plist_path.open('rb') as f: info = plistlib.load(f)
info.update(CFBundleName='Forge', CFBundleDisplayName='Forge', CFBundleIdentifier='dev.forge.editor', CFBundleExecutable='Forge', CFBundleShortVersionString='0.1.0', CFBundleVersion='1')
with plist_path.open('wb') as f: plistlib.dump(info, f)
(destination / 'Contents/MacOS/Electron').rename(destination / 'Contents/MacOS/Forge')
subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(destination)], check=True, capture_output=True)
print(destination)
