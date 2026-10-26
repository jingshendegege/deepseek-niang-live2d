"""Install pinned public dependencies. Cubism Core is deliberately not fetched."""
from pathlib import Path
import hashlib
import io
import json
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def download(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def install():
    manifest = json.loads((ROOT / 'dependencies.json').read_text(encoding='utf-8'))
    for dependency in manifest:
        payload = download(dependency['source'])
        archive = tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') if dependency['source'].endswith('.tgz') else None
        for entry in dependency['files']:
            relative = Path(entry['file'])
            destination = (ROOT / relative).resolve()
            if not destination.is_relative_to((ROOT / 'vendor').resolve()):
                raise ValueError('Dependency destination must be under vendor')
            if archive:
                member = 'package/' + Path(*relative.parts[2:]).as_posix()
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError('Missing dependency member: ' + member)
                content = stream.read()
            else:
                content = payload
            if hashlib.sha256(content).hexdigest() != entry['sha256']:
                raise ValueError('Checksum mismatch: ' + entry['file'])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        # Keep any additional upstream legal notices without extracting arbitrary paths.
        if archive:
            vendor_dir = ROOT / Path(*Path(dependency['files'][0]['file']).parts[:2])
            for member in archive.getmembers():
                leaf = Path(member.name).name
                if member.isfile() and leaf.upper().startswith(('LICENSE', 'NOTICE', 'COPYING', 'COPYRIGHT')):
                    stream = archive.extractfile(member)
                    if stream is not None:
                        (vendor_dir / leaf).write_bytes(stream.read())
            archive.close()
        print('Installed', dependency['name'], dependency.get('version', '1'))
    print('Next: manually install Cubism Core and the complete model; see README.md.')


if __name__ == '__main__':
    install()
