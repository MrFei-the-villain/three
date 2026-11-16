use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, State};
use zeroize::Zeroize;

/// 256-bit (32-byte) master key, derived from a per-install random seed on
/// first launch. Stored in `key.bin` next to the encrypted state file.
const KEY_FILE: &str = "key.bin";
const STATE_FILE: &str = "state.bin";

/// 12-byte nonce used by AES-GCM. Random per write, prepended to the payload.
const NONCE_LEN: usize = 12;

/// Tiny tray-popup window size, logical px. Must match tauri.conf.json.
const TINY_W: f64 = 340.0;
const TINY_H: f64 = 236.0;

struct AppState {
    data_dir: PathBuf,
    cipher: Mutex<Option<Aes256Gcm>>,
}

/// Reads the master key from disk, or generates a fresh one on first launch.
fn load_or_create_key(dir: &PathBuf) -> Result<[u8; 32], String> {
    let key_path = dir.join(KEY_FILE);
    if key_path.exists() {
        let mut buf = [0u8; 32];
        let mut f = fs::File::open(&key_path).map_err(|e| e.to_string())?;
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        return Ok(buf);
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let tmp = dir.join("key.bin.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&key).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &key_path).map_err(|e| e.to_string())?;
    Ok(key)
}

fn build_cipher(key_bytes: &[u8; 32]) -> Aes256Gcm {
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    Aes256Gcm::new(key)
}

fn encrypt_and_store(dir: &PathBuf, cipher: &Aes256Gcm, plaintext: &[u8]) -> Result<(), String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    let target = dir.join(STATE_FILE);
    let tmp = dir.join("state.bin.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&blob).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_and_decrypt(dir: &PathBuf, cipher: &Aes256Gcm) -> Result<Option<Value>, String> {
    let target = dir.join(STATE_FILE);
    if !target.exists() {
        return Ok(None);
    }
    let blob = fs::read(&target).map_err(|e| e.to_string())?;
    if blob.len() < NONCE_LEN + 16 {
        return Err("state file too small to be valid".into());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decrypt: {e}"))?;
    let v: Value = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

#[tauri::command]
fn load_data(state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let guard = state.cipher.lock().map_err(|e| e.to_string())?;
    let cipher = guard.as_ref().ok_or_else(|| "cipher not initialized".to_string())?;
    read_and_decrypt(&state.data_dir, cipher)
}

#[tauri::command]
fn save_data(data: Value, state: State<'_, AppState>) -> Result<(), String> {
    let bytes = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    let guard = state.cipher.lock().map_err(|e| e.to_string())?;
    let cipher = guard.as_ref().ok_or_else(|| "cipher not initialized".to_string())?;
    encrypt_and_store(&state.data_dir, cipher, &bytes)
}

#[tauri::command]
fn reveal_save(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.data_dir.clone();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    }
    Ok(())
}

#[tauri::command]
async fn confirm(message: String, app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    app.dialog()
        .message(message)
        .title("Three")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .show(move |answer| {
            let _ = tx.send(answer);
        });
    // Never block an async-runtime worker: wait for the dialog on a
    // dedicated blocking thread.
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn data_dir_path(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.data_dir.to_string_lossy().to_string())
}

/* ---------- Tray / window helpers ---------- */

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Left-click on the tray icon: toggle the tiny "most urgent task" popup,
/// placed just above the tray and kept inside the monitor.
fn toggle_tiny(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    let Some(win) = app.get_webview_window("tiny") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let monitor = app.primary_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let w_px = TINY_W * scale;
    let h_px = TINY_H * scale;
    let mut x = cursor.x - w_px + 48.0;
    let mut y = cursor.y - h_px - 14.0;
    if let Some(m) = &monitor {
        let mp = m.position();
        let ms = m.size();
        x = x
            .max(mp.x as f64 + 8.0)
            .min(mp.x as f64 + ms.width as f64 - w_px - 8.0);
        y = y
            .max(mp.y as f64 + 8.0)
            .min(mp.y as f64 + ms.height as f64 - h_px - 8.0);
    } else {
        x = x.max(8.0);
        y = y.max(8.0);
    }
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_main(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Resolve the data dir for this platform. Using `app_data_dir`
            // (Tauri's helper) gives the same location as `dirs::data_dir()`
            // but is more correct on macOS and iOS.
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
            let mut key = load_or_create_key(&dir).map_err(|e| format!("key: {e}"))?;
            let cipher = build_cipher(&key);
            key.zeroize();
            app.manage(AppState {
                data_dir: dir,
                cipher: Mutex::new(Some(cipher)),
            });

            // System tray: left-click toggles the tiny popup, right-click
            // opens the menu.
            let open_item = MenuItem::with_id(app, "open", "Open Three", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            TrayIconBuilder::with_id("three-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Three")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_tiny(tray.app_handle(), position);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window hides it to the tray. Quit via the
            // tray menu or the tiny popup's Exit button.
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let _ = window.hide();
                api.prevent_close();
            }
            // The tiny popup dismisses when it loses focus.
            tauri::WindowEvent::Focused(false) if window.label() == "tiny" => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            reveal_save,
            confirm,
            data_dir_path,
            open_main,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
