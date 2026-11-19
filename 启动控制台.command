#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1

export PATH="$PATH:$HOME/.local/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin"
for folder in "$HOME"/.nvm/versions/node/*/bin; do
  if [ -x "$folder/node" ]; then
    export PATH="$PATH:$folder"
  fi
done

supports_node() {
  "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)' 2>/dev/null
}

if ! supports_node node; then
  while IFS= read -r candidate; do
    if supports_node "$candidate"; then
      export PATH="$(dirname -- "$candidate"):$PATH"
      break
    fi
  done < <(type -aP node)
fi

if supports_node node; then
  node scripts/start-macos.ts
  result=$?
else
  printf '%s\n' '请先安装 Node.js 24 或更新版本，再双击启动控制台。' >&2
  result=1
fi

if [ -t 0 ]; then
  printf '\n%s' '按回车关闭此窗口…'
  read -r _
fi
exit "$result"
