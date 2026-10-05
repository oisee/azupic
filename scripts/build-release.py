#!/usr/bin/env python3
"""Cross-build six standalone binaries and reproducible release archives."""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import re
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [(system, arch) for system in ('linux', 'darwin', 'windows')
           for arch in ('amd64', 'arm64')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='Semver, with or without v prefix')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    version = args.version.removeprefix('v')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        parser.error('invalid version')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    checksums = []
    for system, arch in TARGETS:
        name = f'azupic_{version}_{system}_{arch}'
        binary_name = 'azupic.exe' if system == 'windows' else 'azupic'
        binary = output / (name + ('.exe' if system == 'windows' else ''))
        environment = dict(os.environ, CGO_ENABLED='0', GOOS=system, GOARCH=arch)
        subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false',
                        '-ldflags', f'-s -w -buildid= -X main.Version={version}',
                        '-o', str(binary), './cmd/azupic'], cwd=ROOT,
                       env=environment, check=True)
        files = [(binary_name, binary.read_bytes(), 0o755)]
        for path in ('LICENSE', 'README.md', 'README.RU.md'):
            files.append((path, (ROOT / path).read_bytes(), 0o644))
        if system == 'windows':
            archive = output / (name + '.zip')
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                for path, content, mode in files:
                    info = zipfile.ZipInfo(path, (1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = mode << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    z.writestr(info, content)
        else:
            archive = output / (name + '.tar.gz')
            with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as gz:
                with tarfile.open(fileobj=gz, mode='w') as tar:
                    for path, content, mode in files:
                        info = tarfile.TarInfo(path)
                        info.size, info.mode, info.mtime = len(content), mode, 0
                        tar.addfile(info, io.BytesIO(content))
        checksums.append(f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}')
        binary.unlink()
        print(archive.name, flush=True)
    (output / 'checksums.txt').write_text('\n'.join(sorted(checksums)) + '\n')


if __name__ == '__main__':
    main()
