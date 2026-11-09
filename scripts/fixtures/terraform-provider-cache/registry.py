"""Credential-free provider acquisition and loopback-only Terraform cache proof.

https://github.com/chase-sets/chase-sets/issues/11174
Acquisition is not a matrix verdict. Trusted hashes, signatures and keys always
come from the registry/release inputs, never from the synthetic damaged bytes.
"""

import base64
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.request
import zipfile


ROOTS = ("environment-dns", "platform", "doks")
SOURCE = "registry.terraform.io/digitalocean/digitalocean"
BASE_H1 = {
    "environment-dns": b'"h1:B9T7VwtMthS3HMLXzb+Z7XGoovTXyx2T6FJn26ScTJU="',
    "platform": b'"h1:EeAzPHKzqkbSM1IqgVXimkWP9QJvt8cn9TIjd8pujrk="',
    "doks": b'"h1:n2sJGnQabub/1XFLAqzXKK82U/RTpGfbyky/hoQpNi0="',
}


def lock_path(repo, root):
    return repo / "infrastructure/digitalocean" / root / ".terraform.lock.hcl"


def version(lock):
    return re.search(r'version\s*=\s*"([^"]+)"', lock).group(1)


def package_h1(data):
    # Used only to identify the platform of an EXISTING committed h1. This
    # computed value is never served as registry or checksum authority.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        lines = "".join(
            f"{hashlib.sha256(archive.read(name)).hexdigest()}  {name}\n"
            for name in sorted(archive.namelist())
        )
    return "h1:" + base64.b64encode(hashlib.sha256(lines.encode()).digest()).decode()


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def acquire(repo, material):
    material.mkdir(parents=True, exist_ok=False)
    for root in ROOTS:
        lock = lock_path(repo, root).read_text()
        selected = version(lock)
        directory = material / root
        directory.mkdir()
        platforms = []
        existing = set(re.findall(r'"(h1:[^"]+)"', lock))
        # Linux is the runner target. Existing developer locks are identified
        # against verified packages, not guessed from their opaque h1 strings.
        candidates = ["linux_amd64", "windows_amd64", "darwin_arm64", "darwin_amd64"]
        matched = set()
        for platform in candidates:
            os_name, arch = platform.split("_")
            metadata = json.loads(fetch(
                f"https://registry.terraform.io/v1/providers/digitalocean/digitalocean/{selected}/download/{os_name}/{arch}"
            ))
            target = directory / platform
            target.mkdir()
            package = fetch(metadata["download_url"])
            zh = "zh:" + hashlib.sha256(package).hexdigest()
            if f'"{zh}"' not in lock or metadata["shasum"] != zh[3:]:
                raise RuntimeError(f"acquisition {root}/{platform}: package not in committed zh set")
            (target / "package.zip").write_bytes(package)
            (target / "SHA256SUMS").write_bytes(fetch(metadata["shasums_url"]))
            (target / "SHA256SUMS.sig").write_bytes(fetch(metadata["shasums_signature_url"]))
            (target / "metadata.json").write_text(json.dumps(metadata))
            matched.update(existing.intersection({package_h1(package)}))
            platforms.append(platform)
            print(f"ACQUISITION root={root} platform={platform} committed_zh={zh} (not a matrix verdict)", flush=True)
            if platform != "linux_amd64" and matched == existing:
                break
        if matched != existing:
            raise RuntimeError(f"STOP_TO_HOST: unidentified existing h1 platform for {root}")
        (directory / "platforms.json").write_text(json.dumps(platforms))


class Registry(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        fixture = self.server.fixture
        path = self.path
        if path == "/sentinel":
            return self.reply(200, b"loopback fixture")
        if path.endswith("/versions"):
            fixture["counts"]["versions"] += 1
            selected = version(fixture["lock"])
            return self.reply(200, json.dumps({"versions": [{
                "version": selected, "protocols": ["5.0"],
                "platforms": [{"os": "linux", "arch": "amd64"}],
            }]}).encode())
        if "/download/" in path:
            fixture["counts"]["metadata"] += 1
            os_name, arch = path.rsplit("/", 2)[-2:]
            platform = f"{os_name}_{arch}"
            target = fixture["material"] / platform
            metadata = json.loads((target / "metadata.json").read_text())
            origin = f"http://127.0.0.1:{self.server.server_port}/assets/{platform}"
            metadata.update(download_url=f"{origin}/package.zip", shasums_url=f"{origin}/SHA256SUMS",
                            shasums_signature_url=f"{origin}/SHA256SUMS.sig")
            return self.reply(200, json.dumps(metadata).encode())
        if path.startswith("/assets/"):
            fixture["counts"]["assets"] += 1
            if fixture["mode"] == "denied":
                return self.reply(503, b"synthetic release-asset outage")
            _, _, platform, name = path.split("/")
            data = (fixture["material"] / platform / name).read_bytes()
            if fixture["mode"] == "bad-package" and name == "package.zip":
                data = data[:-1] + bytes([data[-1] ^ 1])
            if fixture["mode"] == "bad-signature" and name == "SHA256SUMS":
                # Keep a parseable checksum document and the original package
                # digest, changing only the bytes covered by its signature.
                data += b"\n"
            return self.reply(200, data)
        self.reply(404, b"unregistered fixture path")

    def reply(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def isolated(repo, material, work, terraform, mode):
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=2):
            raise RuntimeError("STOP_TO_HOST: non-loopback egress was reachable")
    except OSError:
        print("SENTINEL non-loopback egress denied", flush=True)
    if any(key.startswith(("TF_VAR_", "AWS_", "DIGITALOCEAN_")) for key in os.environ):
        raise RuntimeError("credential or provider environment inherited")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Registry)
    server.fixture = {}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    if fetch(f"{origin}/sentinel") != b"loopback fixture":
        raise RuntimeError("loopback sentinel failed")
    print("SENTINEL fixture answered; no credential environment", flush=True)
    config = work / "terraform.rc"
    config.write_text('host "registry.terraform.io" {\n services = {\n "providers.v1" = "' + origin + '/"\n }\n}\n')
    env = {**os.environ, "TF_CLI_CONFIG_FILE": str(config), "CHECKPOINT_DISABLE": "1", "TF_IN_AUTOMATION": "true"}
    print(subprocess.check_output([terraform, "version"], env=env, text=True), flush=True)
    try:
        for root in ROOTS:
            original = lock_path(repo, root).read_bytes()
            lock = original.decode()
            server.fixture = {"material": material / root, "lock": lock, "mode": "trusted",
                              "counts": {"versions": 0, "metadata": 0, "assets": 0}}
            directory = work / root
            directory.mkdir()
            (directory / "main.tf").write_text('terraform {\n required_providers {\n digitalocean = {\n source = "digitalocean/digitalocean"\n version = "~> 2.85"\n }\n }\n}\n')
            (directory / ".terraform.lock.hcl").write_bytes(original)
            if mode == "lock":
                platforms = json.loads((material / root / "platforms.json").read_text())
                args = [terraform, "providers", "lock", *[f"-platform={p}" for p in platforms]]
                subprocess.run(args, cwd=directory, env=env, check=True)
                updated = (directory / ".terraform.lock.hcl").read_bytes()
                added = [line for line in updated.splitlines(keepends=True) if line not in original.splitlines(keepends=True)]
                if len(added) != 1 or b'"h1:' not in added[0] or updated.replace(added[0], b"", 1) != original:
                    raise RuntimeError(f"STOP_TO_HOST: {root} lock change is not exactly one h1 addition")
                lock_path(repo, root).write_bytes(updated)
                print(f"LOCK root={root} verified platforms={','.join(platforms)} added={added[0].decode().strip()}", flush=True)
            else:
                matrix(repo, directory, root, original, server, env, terraform)
                if lock_path(repo, root).read_bytes() != original:
                    raise RuntimeError("committed lock changed during proof")
    finally:
        server.shutdown()
        server.server_close()


def matrix(repo, directory, root, original, server, env, terraform):
    selected = version(original.decode())
    package = server.fixture["material"] / "linux_amd64/package.zip"
    if package_h1(package.read_bytes()).encode() not in original:
        raise RuntimeError("acquired Linux package does not match a committed h1")
    trusted = directory / "trusted-cache"
    entry = trusted / SOURCE / selected / "linux_amd64"
    entry.mkdir(parents=True)
    with zipfile.ZipFile(package) as archive:
        archive.extractall(entry)
    for binary in entry.glob("terraform-provider-*"):
        binary.chmod(0o755)
    trusted_bytes = {p.name: p.read_bytes() for p in entry.iterdir()}
    locks = sorted((repo / "infrastructure/digitalocean").glob("*/.terraform.lock.hcl"))
    lock_digest = hashlib.sha256(b"".join(hashlib.sha256(p.read_bytes()).digest() for p in locks)).hexdigest()
    exact_key = f"terraform-providers-Linux-X64-deploy-staging-{lock_digest}"
    saved = directory / exact_key
    shutil.copytree(trusted, saved)
    print(f"CACHE root={root} exact-key={exact_key} saved trusted package", flush=True)
    # Fresh-directory exact-key restores copy the identical saved cache, not a
    # network warm-up. Each state runs the actual production retry entrypoint.
    cases = [("warm-1", "warm", "denied", True), ("warm-2", "warm", "denied", True),
             ("empty", "empty", "denied", False), ("removed-h1", "warm", "denied", False),
             ("tampered-denied", "tampered", "denied", False),
             ("tampered-trusted", "tampered", "trusted", True),
             ("empty-trusted", "empty", "trusted", True),
             ("bad-package", "empty", "bad-package", False),
             ("bad-signature", "empty", "bad-signature", False)]
    cases += [(f"{state}-{origin}", state, origin, origin == "trusted")
              for state in ("absent", "evicted", "stale-key") for origin in ("trusted", "denied")]
    for name, state, origin, success in cases:
        case = directory / name
        case.mkdir()
        shutil.copy(directory / "main.tf", case / "main.tf")
        head_lock = original
        if name == "removed-h1":
            # The single added h1 is identified against the unchanged base lock,
            # not by trusting a digest computed from the cache.
            base_h1 = BASE_H1[root]
            if base_h1 not in original or len(re.findall(rb'"h1:[^"]+"', original)) != 2:
                raise RuntimeError("removed-h1 control cannot bind base lock")
            head_lock = b"".join(line for line in original.splitlines(keepends=True)
                                 if b'"h1:' not in line or base_h1 in line)
        (case / ".terraform.lock.hcl").write_bytes(head_lock)
        cache = case / "cache"
        if state in ("warm", "tampered"):
            shutil.copytree(saved, cache)
            if state == "warm":
                print(f"RESTORE root={root} case={name} exact-key={exact_key} fresh-runner={case}", flush=True)
        elif state != "absent":
            cache.mkdir()
            if state == "stale-key":
                (cache / "stale-key-sentinel").write_text("synthetic stale-key restore; locked package absent")
        altered = None
        if state == "tampered":
            binary = next((cache / SOURCE / selected / "linux_amd64").glob("terraform-provider-*"))
            altered = bytearray(binary.read_bytes())
            altered[-1] ^= 1
            binary.write_bytes(altered)
        counts = {"versions": 0, "metadata": 0, "assets": 0}
        server.fixture.update(mode=origin, counts=counts)
        result = subprocess.run(["bash", str(repo / "scripts/terraform-init-with-retry.sh"),
                                 "-backend=false", "-input=false", "-no-color", "-lockfile=readonly"],
                                cwd=case, env={**env, "TF_PLUGIN_CACHE_DIR": str(cache),
                                "TERRAFORM_INIT_RETRY_ATTEMPTS": "1"}, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (case / "init.log").write_text(result.stdout)
        stage = "package" if counts["metadata"] else "cache" if result.returncode == 0 else "discovery"
        if name in ("bad-package", "bad-signature") and counts["assets"]:
            stage = "package-verification"
        print(f"CASE root={root} case={name} exit={result.returncode} stage={stage} "
              f"versions={counts['versions']} metadata={counts['metadata']} assets={counts['assets']}", flush=True)
        if (result.returncode == 0) != success or counts["versions"] < 1:
            print(result.stdout, flush=True)
            raise RuntimeError(f"STOP_TO_HOST: unexpected case result {root}/{name}")
        warm = name in ("warm-1", "warm-2")
        if warm and (counts["metadata"] or counts["assets"]):
            raise RuntimeError("matching cache fetched package metadata/assets")
        if not warm and (not counts["metadata"] or not counts["assets"]):
            raise RuntimeError("control did not reach package stage")
        if (case / ".terraform.lock.hcl").read_bytes() != head_lock:
            raise RuntimeError("init modified lock bytes")
        installed = case / ".terraform/providers" / SOURCE / selected / "linux_amd64"
        for path in installed.glob("*"):
            if altered is not None and path.read_bytes() == altered:
                raise RuntimeError("altered cached bytes were installed")
        if success and (not installed.is_dir() or any(
            not (installed / name).exists() or (installed / name).read_bytes() != data
            for name, data in trusted_bytes.items()
        )):
            raise RuntimeError("installed bytes differ from independently verified package")
        if name == "bad-package" and "checksum" not in result.stdout.lower():
            raise RuntimeError("bad package did not fail checksum verification")
        if name == "bad-signature" and "signature" not in result.stdout.lower():
            raise RuntimeError("bad checksum document did not fail signature verification")
        if not cache.is_dir():
            raise RuntimeError("retry entrypoint did not create absent cache directory")
        print(f"ASSERT root={root} case={name} lock_unchanged=true altered_installed=false "
              f"installed_trusted={'true' if success else 'not-installed'} "
              f"verification={'signature' if name == 'bad-signature' else 'checksum' if name == 'bad-package' else 'lock'}", flush=True)


if __name__ == "__main__":
    mode, repo, material = sys.argv[1:4]
    if mode == "acquire":
        acquire(Path(repo), Path(material))
    else:
        isolated(Path(repo), Path(material), Path(sys.argv[4]), sys.argv[5], mode)
