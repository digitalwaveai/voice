# -*- mode: python ; coding: utf-8 -*-

import os
from PyInstaller.utils.hooks import collect_all


block_cipher = None

project_dir = os.path.abspath(".")


# ============================
# Collect external packages
# ============================

openwakeword_data = collect_all("openwakeword")
onnxruntime_data = collect_all("onnxruntime")
vosk_data = collect_all("vosk")
sounddevice_data = collect_all("sounddevice")
pyaudio_data = collect_all("pyaudio")


# ============================
# Datas (resources + project)
# ============================

datas = []

# Native package resources
datas += openwakeword_data[0]
datas += onnxruntime_data[0]
datas += vosk_data[0]
datas += sounddevice_data[0]
datas += pyaudio_data[0]

# Project folders + config
datas += [
    (os.path.join(project_dir, "models"), "models"),
    (os.path.join(project_dir, "core"), "core"),
    (os.path.join(project_dir, "config.yaml"), "."),
    (os.path.join(project_dir, "commands.yaml"), "."),
]


# ============================
# Native binaries
# ============================

binaries = []
binaries += openwakeword_data[1]
binaries += onnxruntime_data[1]
binaries += vosk_data[1]
binaries += pyaudio_data[1]


# ============================
# Hidden imports
# ============================

hiddenimports = []
hiddenimports += openwakeword_data[2]
hiddenimports += onnxruntime_data[2]
hiddenimports += vosk_data[2]
hiddenimports += sounddevice_data[2]
hiddenimports += pyaudio_data[2]


# ============================
# Excludes (CPU safety)
# ============================

excludes = [
    "rapidfuzz.fuzz_cpp_avx2",   # avoid crash on CPUs without AVX2
]


# ============================
# Analysis
# ============================

a = Analysis(
    ['main.py'],
    pathex=[project_dir],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)


# ============================
# Python archive
# ============================

pyz = PYZ(
    a.pure,
    cipher=block_cipher
)


# ============================
# Executable
# ============================

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Jarvis',
    icon='assets/icon.png',
    version='assets/version.txt',
    debug=False,
    strip=False,
    upx=True,
    console=True,
    uac_admin=False,
    disable_windowed_traceback=False,
)


# ============================
# Final folder (portable dir)
# ============================

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    name='Jarvis'
)
