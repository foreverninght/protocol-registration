import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('release_builder', Path(__file__).resolve().parents[1] / 'tools' / 'build-release.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ReleaseArchiveTests(unittest.TestCase):
    def test_license_notices_are_included_without_runtime_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = (Path(directory) / 'source').resolve()
            root.mkdir()
            for name in builder.TOP:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture\n', encoding='utf-8')
            for name in ['LICENSE', 'NOTICE.txt', 'vendor/example/COPYING', 'vendor/example/LICENSE-MIT', 'vendor/example/NOTICE.md', 'data/passwords.txt', '.env', 'vendor/example/session.json', 'node_modules/dep/LICENSE']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('fixture\n', encoding='utf-8')
            previous = builder.ROOT
            try:
                builder.ROOT = root
                output = Path(directory) / 'release.zip'
                with contextlib.redirect_stdout(io.StringIO()):
                    builder.build(output)
                with zipfile.ZipFile(output) as archive:
                    names = set(archive.namelist())
                    self.assertIn('protocol-registration/src/phone/smsbower-countries.json', names)
                    for name in ['LICENSE', 'NOTICE.txt', 'vendor/example/COPYING', 'vendor/example/LICENSE-MIT', 'vendor/example/NOTICE.md']:
                        self.assertIn('protocol-registration/' + name, names)
                    for name in ['.env', 'data/passwords.txt', 'vendor/example/session.json', 'node_modules/dep/LICENSE']:
                        self.assertNotIn('protocol-registration/' + name, names)
            finally:
                builder.ROOT = previous

    def test_license_match_does_not_allow_arbitrary_secret_extensions(self):
        self.assertFalse(builder.is_license_file(Path('LICENSE.env')))
        self.assertFalse(builder.is_license_file(Path('LICENSE.json')))
        self.assertTrue(builder.is_license_file(Path('license-apache.txt')))


if __name__ == '__main__':
    unittest.main()
