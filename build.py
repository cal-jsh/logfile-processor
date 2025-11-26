import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
RUST_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
DEPLOY_DIR = ROOT / "deploy"

FRONTEND_BUILD_DIR = FRONTEND_DIR / "dist"   # Change to "build" if using CRA
RUST_EXE = RUST_DIR / "target" / "release" / "logfile_processor.exe"


def run(cmd, cwd=None):
    print(f"\n🔧 Running: {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=True)


def clean_deploy():
    if DEPLOY_DIR.exists():
        shutil.rmtree(DEPLOY_DIR)
    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)


def build_rust():
    print("\n=== Building Rust Backend ===")
    run(["cargo", "build", "--release"], cwd=RUST_DIR)
    if not RUST_EXE.exists():
        raise FileNotFoundError(f"Rust build succeeded but {RUST_EXE} not found")


def build_frontend():
    print("\n=== Building Frontend ===")
    run(["npm.cmd", "install"], cwd=FRONTEND_DIR)
    run(["npm.cmd", "run", "build"], cwd=FRONTEND_DIR)
    if not FRONTEND_BUILD_DIR.exists():
        raise RuntimeError(f"Frontend build missing: {FRONTEND_BUILD_DIR}")


def assemble_deploy():
    print("\n=== Assembling Deploy Folder ===")
    
    # Copy Rust executable
    shutil.copy2(RUST_EXE, DEPLOY_DIR / RUST_EXE.name)
    
    # Copy frontend
    frontend_out = DEPLOY_DIR / "frontend"
    shutil.copytree(FRONTEND_BUILD_DIR, frontend_out)

    # Copy config
    config_file = ROOT / "config.json"
    if config_file.exists():
        shutil.copy2(config_file, DEPLOY_DIR / "config.json")

    print("\n🎉 Deployment folder ready!")
    print(f"➡ {DEPLOY_DIR}")


def main():
    clean_deploy()
    build_rust()
    build_frontend()
    assemble_deploy()


if __name__ == "__main__":
    main()
