#!/usr/bin/env python3
"""Build offline installers with a verified Node binary and platform dependencies."""
from pathlib import Path
import argparse
import hashlib
import json
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
import re
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'plugins/tilda-connect'
VERSION = json.loads((SOURCE / 'package.json').read_text())['version']
NODE = 'v24.22.1'
TARGETS = {
    'mac-arm64': ('darwin', 'arm64', 'tar.gz', '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7'),
    'mac-intel': ('darwin', 'x64', 'tar.gz', 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035'),
    'windows-x64': ('win', 'x64', 'zip', 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'),
    'windows-arm64': ('win', 'arm64', 'zip', 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171'),
}
PARTS = ['package.json', 'package-lock.json', 'plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin', '.claude-plugin', 'scripts', 'skills', 'ui', 'LICENSE']


def download(name, expected):
    cache = ROOT / '.build-cache'
    cache.mkdir(exist_ok=True)
    archive = cache / name
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        temporary = archive.with_suffix('.download')
        print(f'Downloading official Node.js: {name}', flush=True)
        url = f'https://nodejs.org/dist/{NODE}/{name}'
        headers = cache / f'{name}.headers'
        probe = cache / f'{name}.probe'
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '30', '--max-filesize', '2048', '--range', '0-0', '-D', str(headers), url, '-o', str(probe)], check=True)
        match = re.search(r'content-range:\s*bytes 0-0/(\d+)', headers.read_text(), flags=re.I)
        if not match:
            raise ValueError('Official download server did not honor byte ranges')
        total = int(match[1])
        prefix = temporary.stat().st_size if temporary.exists() else 0
        if prefix > total:
            temporary.unlink()
            prefix = 0
        chunks = [(start, min(start + 4 * 1024 * 1024, total) - 1) for start in range(prefix, total, 4 * 1024 * 1024)]
        def fetch_chunk(item):
            start, end = item
            chunk = cache / f'{name}.part-{start}'
            length = end - start + 1
            if chunk.exists() and chunk.stat().st_size > length:
                chunk.unlink()
            attempts = 0
            while not chunk.exists() or chunk.stat().st_size < length:
                attempts += 1
                if attempts > 8:
                    raise ValueError('Download repeatedly interrupted; rerun to resume')
                received = chunk.stat().st_size if chunk.exists() else 0
                tail = chunk.with_suffix(chunk.suffix + '.tail')
                response = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '120', '--range', f'{start+received}-{end}', '--max-filesize', str(length-received), url, '-o', str(tail)])
                if tail.exists() and tail.stat().st_size and response.returncode in (0, 28):
                    with chunk.open('ab') as output, tail.open('rb') as input_file:
                        shutil.copyfileobj(input_file, output)
                tail.unlink(missing_ok=True)
            if chunk.stat().st_size != end - start + 1:
                raise ValueError('Unexpected download chunk size')
            return chunk
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(fetch_chunk, chunks))
        with temporary.open('ab') as output:
            for chunk in results:
                with chunk.open('rb') as input_file:
                    shutil.copyfileobj(input_file, output)
                chunk.unlink()
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            temporary.unlink()
            raise ValueError('Node.js checksum mismatch')
        temporary.replace(archive)
    return archive


def extract_runtime(archive, base_name, destination, system):
    destination.mkdir(parents=True)
    wanted = ['node.exe', 'LICENSE'] if system == 'win' else ['bin/node', 'LICENSE']
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as source:
            for item in wanted:
                output = destination / Path(item).name
                output.write_bytes(source.read(f'{base_name}/{item}'))
    else:
        with tarfile.open(archive) as source:
            for item in wanted:
                output = destination / Path(item).name
                output.write_bytes(source.extractfile(f'{base_name}/{item}').read())
    if system != 'win':
        (destination / 'node').chmod(0o755)


def build(target):
    system, arch, extension, expected = TARGETS[target]
    base_name = f'node-{NODE}-{system}-{arch}'
    archive = download(f'{base_name}.{extension}', expected)
    staging = ROOT / '.build-cache' / f'installer-{target}'
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    if system == 'darwin':
        package = staging / 'Tilda Connect.app'
        resources = package / 'Contents/Resources'
        (package / 'Contents/MacOS').mkdir(parents=True)
        resources.mkdir()
        info = {'CFBundleName': 'Tilda Connect', 'CFBundleDisplayName': 'Tilda Connect', 'CFBundleIdentifier': 'ru.avtomato.tilda-connect', 'CFBundleVersion': VERSION, 'CFBundleShortVersionString': VERSION, 'CFBundleExecutable': 'TildaConnect', 'CFBundlePackageType': 'APPL', 'LSMinimumSystemVersion': '13.5', 'LSUIElement': True, 'NSHighResolutionCapable': True}
        (package / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        launcher = package / 'Contents/MacOS/TildaConnect'
        launcher.write_text('#!/bin/sh\napp_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"\nexec "$app_dir/runtime/node" "$app_dir/app/scripts/wizard.mjs" "$@"\n')
        launcher.chmod(0o755)
    else:
        package = staging / 'Tilda Connect'
        resources = package
        resources.mkdir(parents=True)
        (package / 'Подключить Tilda.cmd').write_bytes('@echo off\r\nstart "Tilda Connect" /min "%~dp0runtime\\node.exe" "%~dp0app\\scripts\\wizard.mjs"\r\nexit /b\r\n'.encode('utf-8'))
    app = resources / 'app'
    app.mkdir()
    for part in PARTS:
        source = SOURCE / part
        if source.is_dir():
            shutil.copytree(source, app / part)
        else:
            shutil.copy2(source, app / part)
    print(f'Installing pinned dependencies for {target}', flush=True)
    subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', f'--os={"win32" if system == "win" else system}', f'--cpu={arch}'], cwd=app, check=True, stdout=subprocess.DEVNULL)
    shutil.rmtree(app / 'node_modules/.bin', ignore_errors=True)
    extract_runtime(archive, base_name, resources / 'runtime', system)
    (resources / 'app/bundle.json').write_text(json.dumps({'version': VERSION, 'platform': 'win32' if system == 'win' else system, 'arch': arch, 'node': NODE, 'nodeArchiveSHA256': expected}, indent=2) + '\n')
    instructions = ('Tilda Connect\n\n1. Распакуйте архив полностью.\n2. Откройте Tilda Connect.app.\n' if system == 'darwin' else 'Tilda Connect\n\n1. Нажмите «Извлечь всё» и распакуйте архив.\n2. Откройте папку Tilda Connect и запустите «Подключить Tilda.cmd».\n')
    instructions += '3. В открывшемся окне выберите Codex или Claude, вставьте ключ Tilda и нажмите «Подключить Tilda».\n4. Перезапустите выбранное приложение.\n\nКлюч создаётся в Tilda → Профиль → MCP-сервер → Новый ключ.\nВсе необходимые компоненты уже включены. Конфигурация создаётся автоматически.\nКлюч сохраняется только в системном хранилище вашего компьютера.\n\nЭта сборка не подписана сертификатом издателя. Система может попросить подтвердить запуск.\n'
    (staging / 'Начните здесь.txt').write_text(instructions)
    output = ROOT / 'dist' / f'tilda-connect-{VERSION}-{target}.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as release:
        for file in sorted(staging.rglob('*')):
            if file.is_symlink():
                raise ValueError(f'Unexpected symlink: {file.relative_to(staging)}')
            if not file.is_file():
                continue
            if file.suffix in {'.mjs', '.js', '.json', '.md', '.txt', '.html', '.css', '.map'} and str(Path.home()).encode() in file.read_bytes():
                raise ValueError(f'Personal machine path in bundle: {file.relative_to(staging)}')
            release.write(file, file.relative_to(staging))
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n')
    print(f'Built {output.name}: {output.stat().st_size // 1024 // 1024} MiB; SHA256 {digest}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('targets', nargs='*', choices=list(TARGETS), default=['mac-arm64', 'windows-x64'])
    args = parser.parse_args()
    for target in args.targets:
        build(target)
