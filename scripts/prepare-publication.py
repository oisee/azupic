#!/usr/bin/env python3
"""Build an allowlisted source snapshot and inspect it without printing secrets."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent.parent
FILES = ('.gitignore', 'go.mod', 'LICENSE', 'README.md', 'README.RU.md')
DIRS = ('cmd', 'internal', 'docs', 'reference', 'scripts', '.github')


def excluded(path):
    parts = path.relative_to(ROOT).parts
    return (any(part in ('.git', '.local', '.aws', '.codex', '.agents', 'dist',
                         '__pycache__', 'node_modules') for part in parts)
            or path.name == 'HANDOVER.md'
            or path.name.endswith(('.log', '.pyc', '.pem', '.key'))
            or path.name == '.env'
            or (path.name.startswith('.env.') and path.name != '.env.example'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        parser.error('destination must not already exist')
    paths = [ROOT / p for p in FILES]
    for folder in DIRS:
        for p in sorted((ROOT / folder).rglob('*')):
            if excluded(p):
                continue
            if p.is_symlink():
                parser.error('symlink in publication tree: ' + str(p.relative_to(ROOT)))
            if p.is_file():
                paths.append(p)

    # Compare against inherited secrets directly; never print values or hashes.
    secret_values = [value.encode() for name, value in os.environ.items()
                     if re.search(r'(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)', name, re.I)
                     and len(value) >= 12]
    suspicious = re.compile(rb'(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AccountKey=[A-Za-z0-9+/]{30,})')
    personal = re.compile(rb'(?:/home/(?!node/)[A-Za-z0-9_.-]+/|/Users/[A-Za-z0-9_.-]+/|https://(?!(?:RESOURCE|example)\.)[A-Za-z0-9-]+\.openai\.azure\.com)')
    problems = []
    manifest = []
    for p in paths:
        rel = p.relative_to(ROOT).as_posix()
        data = p.read_bytes()
        if p.is_symlink() or not p.is_file():
            problems.append((rel, 'not a regular source file'))
        if any(value in data for value in secret_values):
            problems.append((rel, 'matches an inherited credential'))
        if suspicious.search(data):
            problems.append((rel, 'credential pattern'))
        # Ignore the scanner's own literal denylist and gitignore exclusions.
        if rel not in ('scripts/prepare-publication.py', '.gitignore') and personal.search(data):
            problems.append((rel, 'personal host/path'))
        # Synthetic opaque envelopes must remain synthetic after decoding.
        for signature in re.findall(rb'ccp:openai:v1:([A-Za-z0-9_-]+)', data):
            try:
                payload = json.loads(base64.urlsafe_b64decode(signature + b'=' * (-len(signature) % 4)))
                if payload.get('item', {}).get('encrypted_content') != 'synthetic-opaque-state':
                    problems.append((rel, 'non-synthetic reasoning envelope'))
            except (ValueError, TypeError):
                problems.append((rel, 'unreadable reasoning envelope'))
        manifest.append({'path': rel, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    if problems:
        for path, reason in problems:
            print(f'BLOCKED: {path}: {reason}')
        raise SystemExit(1)
    for p in paths:
        target = destination / p.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
    (destination / 'PUBLICATION-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared {len(paths)} source files at {destination}')
    print('No inherited credential matches, credential patterns, or personal endpoints in publication sources.')
    print('Excluded: handover, local logs/configuration, binaries, workspace credential mounts and git metadata.')


if __name__ == '__main__':
    main()
