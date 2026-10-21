#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null; then
  echo 'Установите Node.js 22 или новее с https://nodejs.org/ и запустите этот файл снова.'
else
  node setup.mjs --connect
fi
read -r '?Нажмите Enter, чтобы закрыть окно.'
