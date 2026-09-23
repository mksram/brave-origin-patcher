# Brave Origin patcher

A ReVanced-style patcher for the official Brave Browser for Android. It takes a Brave app bundle **that you supply from your own device**, applies a set of bytecode and preference patches, re-signs the splits, and installs them side-by-side with the Play Store build.

No APK is distributed here. This repository contains patch scripts only.

## Requirements
Termux on Android, or any Linux distribution with the following packages installed:
```bash
pkg update -y && pkg install -y apktool apksigner nodejs android-tools unzip git
```

## Usage
```bash
node bravepatch.js probe /path/to/Brave.apks
node origin.js /path/to/Brave.apks -o out
node verify-origin.js out io.github.mksram.braveorigin
node bravepatch.js install out
```

## Disclaimer
This is an unofficial, independent project. It is **not** affiliated with, endorsed by, or supported by Brave Software, Inc. Use at your own risk.

## License
MIT. See `LICENSE` for details.
