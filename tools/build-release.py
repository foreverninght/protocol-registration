import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOP = ['.gitignore', '.gitattributes', '.env.example', 'README.md', 'THIRD_PARTY.md',
       'SOURCE_SNAPSHOT.json', 'package.json', 'package-lock.json', 'requirements.txt', 'compose.yaml',
       'src/phone/smsbower-countries.json']
TREES = ['src', 'public', 'tools', 'tests', 'db', 'docs', 'vendor', 'python']
EXTENSIONS = {'.js', '.cjs', '.mjs', '.py', '.sql', '.md', '.css', '.html', '.svg', '.wasm'}
EXCLUDED = {'node_modules', '__pycache__', '.venv', 'data', 'logs', 'tokens', '.git'}

def is_license_file(source):
    name = source.name.upper()
    stem = source.stem.upper()
    return source.suffix.lower() in {'', '.md', '.txt', '.rst'} and any(
        name == label or stem == label or stem.startswith(label + '-')
        for label in ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT', 'AUTHORS')
    )


def build(output):
    output = Path(output).resolve()
    entries = {name: ROOT / name for name in TOP}
    for source in ROOT.iterdir():
        if source.is_file() and is_license_file(source):
            entries[source.name] = source
    for tree in TREES:
        for source in (ROOT / tree).rglob('*'):
            relative = source.relative_to(ROOT)
            if any(part in EXCLUDED for part in relative.parts):
                continue
            if (source.suffix in EXTENSIONS or source.name == 'requirements.txt' or is_license_file(source)) and source.is_file():
                entries[relative.as_posix()] = source
    data = {}
    for name, source in sorted(entries.items()):
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(ROOT):
            raise ValueError('Invalid release source: ' + name)
        data[name] = source.read_bytes()
    manifest = ''.join(hashlib.sha256(value).hexdigest() + '  ' + name + '\n' for name, value in data.items())
    (ROOT / 'SHA256SUMS').write_text(manifest, encoding='utf-8', newline='\n')
    data['SHA256SUMS'] = manifest.encode('utf-8')
    target = output.open('xb')
    identity = os.fstat(target.fileno())
    try:
        with target, zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in sorted(data.items()):
                info = zipfile.ZipInfo('protocol-registration/' + name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, value)
    except BaseException:
        try:
            current = output.lstat()
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                output.unlink()
        except OSError:
            pass
        raise
    print(json.dumps({'files': len(data), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Build a source-only registration release candidate.')
    parser.add_argument('--output', required=True)
    build(parser.parse_args().output)
