# Three

A tiny **3-task queue for chronic procrastinators**. Store as many tasks as you want — Three only ever shows you the three most urgent, so you always know what to do next.

Built with [Tauri 2](https://tauri.app) (Rust backend, plain HTML/CSS/JS frontend). Everything stays on your machine; your data is encrypted at rest with AES-256-GCM.

## Features

- **3 most urgent tasks** — ranked by priority → minimum time → deadline
- **Encrypted local storage** — AES-256-GCM with a per-install random key
- **Tap-to-start timers** — progress ring tracks the minimum time you set
- **Daily mode** — plan each day's homework when the day starts
- **Long-holiday planning** — National Day, May Day, Spring Festival, winter/summer breaks: plan once on the first day, tasks persist for the whole break
- **System tray** — left-click the tray icon for a popup with your most urgent task; closing the window hides to tray
- **Archive** — finished days are kept for review
- Light / dark theme, Windows 10/11

## Build from source

Requires [Rust](https://rustup.rs/) and the Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
cargo tauri icon app-icon.svg   # regenerate src-tauri/icons/ (first build only)
cargo tauri build
```

The built executable ends up in `src-tauri/target/release/three.exe`.
