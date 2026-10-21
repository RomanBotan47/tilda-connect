#!/usr/bin/env python3
"""Build a credential-free source archive from an explicit allowlist."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins' / 'tilda-connect'
VERSION = json.loads((PLUGIN / 'package.json').read_text())['version']
PREFIX = f'tilda-connect-{VERSION}'
OUTPUT = ROOT / 'dist' / f'{PREFIX}-source.zip'
ROOT_FILES = ['.gitignore', 'package.json', 'README.md', 'setup.mjs', 'tilda.mjs', 'Установить.command', 'Установить.cmd', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'scripts/package.py', 'scripts/build-desktop.py']
PLUGIN_PARTS = ['package.json', 'package-lock.json', 'plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin', '.claude-plugin', 'scripts', 'skills', 'ui', 'LICENSE']


def collect(path):
    if path.is_symlink():
        raise ValueError('Symlinks cannot be included')
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from collect(child)
    else:
        yield path


files = [ROOT / p for p in ROOT_FILES]
for part in PLUGIN_PARTS:
    files.extend(collect(PLUGIN / part))
files.extend(collect(ROOT / 'tests'))
OUTPUT.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(OUTPUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(set(files)):
        relative = file.relative_to(ROOT)
        if set(relative.parts) & {'.git', 'node_modules', '__pycache__'} or file.name.startswith('.env'):
            raise ValueError(f'Forbidden artifact: {relative}')
        data = file.read_bytes()
        # Prevent accidentally shipping machine-specific installed configurations.
        if str(Path.home()).encode() in data:
            raise ValueError(f'Personal absolute path in {relative}')
        info = zipfile.ZipInfo(f'{PREFIX}/{relative.as_posix()}', (2026, 10, 21, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o100755 if file.suffix in {'.command', '.mjs', '.py'} else 0o100644) << 16
        archive.writestr(info, data)
checksum = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix('.zip.sha256').write_text(f'{checksum}  {OUTPUT.name}\n')
print(f'{OUTPUT}\n{OUTPUT.stat().st_size:,} bytes\nSHA256 {checksum}')
