#!/bin/zsh
cd -- "${0:A:h}"
if [[ -d ../Forge.app ]]; then
  exec open -a "${PWD:h}/Forge.app"
fi
FORGE_NODE=$(command -v node)
if [[ -z "$FORGE_NODE" ]]; then
  for FORGE_CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$FORGE_CANDIDATE" ]]; then
      FORGE_NODE="$FORGE_CANDIDATE"
      break
    fi
  done
fi
if [[ ! -x "$FORGE_NODE" ]]; then
  print 'Install Node.js 24, then run npm install and npm run build.'
  read -k 1
  exit 1
fi
if [[ ! -f node_modules/electron/cli.js || ! -f dist/index.html ]]; then
  print 'Run npm install and npm run build in this folder, then launch again.'
  read -k 1
  exit 1
fi
exec "$FORGE_NODE" node_modules/electron/cli.js .
