// RORA Island — Fase 1 (Tauri v2, Windows)
// Jendela pasif always-on-top. Tidak menyentuh proses game sama sekali.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lyrics;
mod media;
mod bridge;

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use lyrics::LyricsResult;
use media::NowPlaying;
use tauri::Manager;

pub struct MonitorPref(pub std::sync::Mutex<Option<usize>>);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[tauri::command]
async fn get_now_playing(app: tauri::AppHandle) -> NowPlaying {
    let mut track = media::get_now_playing().await;
    let is_spotify = track
        .source
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .contains("spotify");
    if is_spotify {
        let state = app.state::<bridge::BridgeState>();
        let progress = state.progress.lock().unwrap().clone();
        if let Some(p) = progress {
            let age_ms = now_ms().saturating_sub(p.received_at_ms);
            if age_ms < 1500 && p.duration_ms > 0.0 {
                let dur = p.duration_ms / 1000.0;
                track.position_secs = (p.position_ms / 1000.0).clamp(0.0, dur);
                track.duration_secs = dur;
                track.is_playing = p.is_playing;
                track.position_updated_at_ms = p.received_at_ms as f64;
            }
        }
    }
    track
}

#[tauri::command]
async fn media_toggle() -> bool {
    media::toggle().await
}

#[tauri::command]
async fn media_next() -> bool {
    media::next().await
}

#[tauri::command]
async fn media_prev() -> bool {
    media::prev().await
}

#[tauri::command]
async fn get_lyrics(
    app: tauri::AppHandle,
    title: String,
    artist: String,
    duration_secs: f64,
) -> LyricsResult {
    lyrics::get_lyrics(&app, &title, &artist, duration_secs).await
}

fn resolve_target_monitor(app: &tauri::AppHandle) -> Result<tauri::Monitor, String> {
    let preferred_idx = *app.state::<MonitorPref>().0.lock().unwrap();
    if let Some(idx) = preferred_idx {
        if let Ok(monitors) = app.available_monitors() {
            if let Some(m) = monitors.into_iter().nth(idx) {
                return Ok(m);
            }
        }
    }
    if let Ok(Some(primary)) = app.primary_monitor() {
        return Ok(primary);
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(cur)) = window.current_monitor() {
            return Ok(cur);
        }
    }
    Err("monitor tidak ditemukan".to_string())
}

fn monitor_geometry(app: &tauri::AppHandle) -> Result<(f64, f64, f64, f64), String> {
    let monitor = resolve_target_monitor(app)?;
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    Ok((
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        scale,
    ))
}

fn set_island_wh(app: &tauri::AppHandle, w: f64, h: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("window 'main' tidak ditemukan")?;
    let (mx, my, mw, _scale) = monitor_geometry(app)?;
    let x = mx + (mw - w) / 2.0;
    window
        .set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y: my }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn set_island_size(app: &tauri::AppHandle, _expanded: bool) -> Result<(), String> {
    set_island_wh(app, 196.0, 46.0)
}

static ANIMATION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn animate_island_to(app: &tauri::AppHandle, target_w: f64, target_h: f64) {
    use std::sync::atomic::Ordering;
    let seq = ANIMATION_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();

    std::thread::spawn(move || {
        let Some(window) = app.get_webview_window("main") else { return };
        let Ok(scale) = window.scale_factor() else { return };
        let Ok(size) = window.inner_size() else { return };
        let Ok(pos) = window.outer_position() else { return };
        let (cur_w, cur_h) = (size.width as f64 / scale, size.height as f64 / scale);
        let Ok((mx, my, mw, _monitor_scale)) = monitor_geometry(&app) else { return };
        let target_x = mx + (mw - target_w) / 2.0;
        let cur_x = pos.x as f64 / scale;
        let cur_y = pos.y as f64 / scale;

        if (cur_w - target_w).abs() < 0.5
            && (cur_h - target_h).abs() < 0.5
            && (cur_x - target_x).abs() < 1.0
            && (cur_y - my).abs() < 1.0
        {
            return;
        }

        let duration = std::time::Duration::from_millis(220);
        let started = std::time::Instant::now();

        loop {
            if ANIMATION_SEQ.load(Ordering::SeqCst) != seq { return; }
            let elapsed = started.elapsed();
            let mut t = elapsed.as_secs_f64() / duration.as_secs_f64();
            let done = t >= 1.0;
            if done { t = 1.0; }
            let eased = 1.0 - (1.0 - t).powi(3);
            let w = cur_w + (target_w - cur_w) * eased;
            let h = cur_h + (target_h - cur_h) * eased;
            let x = mx + (mw - w) / 2.0;
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: w, height: h }));
            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y: my }));
            if done { break; }
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    });
}

#[tauri::command]
fn set_island_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let (base_mode, has_menu) = match mode.strip_suffix("-menu") {
        Some(m) => (m, true),
        None => (mode.as_str(), false),
    };
    let (w, mut h) = match base_mode {
        "home" => (196.0, 46.0),
        "home-expanded" => (196.0, 94.0),
        "music" => (320.0, 46.0),
        "music-hover" => (320.0, 124.0),
        "music-hover-playlist" => (320.0, 216.0),
        "music-lyrics" => (320.0, 102.0),
        "music-lyrics-hover" => (320.0, 180.0),
        "music-lyrics-hover-playlist" => (320.0, 272.0),
        "paused" => (292.0, 46.0),
        "paused-hover" => (292.0, 100.0),
        "lyrics" => (320.0, 102.0),
        _ => (196.0, 46.0),
    };
    if has_menu {
        h += 34.0;
    }
    animate_island_to(&app, w, h);
    Ok(())
}

#[tauri::command]
fn set_island_height(app: tauri::AppHandle, h: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("window 'main' tidak ditemukan")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = size.width as f64 / scale;
    animate_island_to(&app, w, h);
    Ok(())
}

#[tauri::command]
fn get_monitors(app: tauri::AppHandle) -> serde_json::Value {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary_pos = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| (m.position().x, m.position().y));
    let current = resolve_target_monitor(&app).ok();
    let cur_pos = current.as_ref().map(|m| (m.position().x, m.position().y));

    let mut current_index = 0usize;
    let mut list = Vec::new();
    for (idx, m) in monitors.iter().enumerate() {
        let pos = (m.position().x, m.position().y);
        let is_primary = primary_pos == Some(pos);
        if cur_pos == Some(pos) {
            current_index = idx;
        }
        list.push(serde_json::json!({
            "index": idx,
            "is_primary": is_primary,
            "label": if is_primary {
                format!("Monitor {} (Utama)", idx + 1)
            } else {
                format!("Monitor {}", idx + 1)
            }
        }));
    }
    serde_json::json!({
        "count": list.len(),
        "current_index": current_index,
        "monitors": list
    })
}

#[tauri::command]
fn set_target_monitor(app: tauri::AppHandle, index: usize) -> Result<String, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    if index >= monitors.len() {
        return Err("Monitor tidak ditemukan".to_string());
    }
    *app.state::<MonitorPref>().0.lock().unwrap() = Some(index);

    let window = app
        .get_webview_window("main")
        .ok_or("window 'main' tidak ditemukan")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let w = size.width as f64 / scale;
    let h = size.height as f64 / scale;
    set_island_wh(&app, w, h)?;

    Ok(format!("Dipindah ke Monitor {}", index + 1))
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    let wake_state = app.state::<WakeState>();
    if let Some(mut child) = wake_state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    app.exit(0);
}

#[tauri::command]
async fn bridge_add_now(app: tauri::AppHandle) -> serde_json::Value {
    let track = media::get_now_playing().await;
    if !track.playing {
        return serde_json::json!({
            "success": false,
            "message": "Tidak ada lagu yang sedang diputar di Spotify desktop."
        });
    }
    let bridge_state = app.state::<bridge::BridgeState>().inner().clone();
    if !bridge_state.is_spicetify_connected() {
        return serde_json::json!({
            "success": false,
            "message": "Spotify desktop belum terhubung ke bridge RORA. Pastikan Spotify terbuka dan Spicetify aktif."
        });
    }
    let cmd_id = bridge_state.send_add();
    match bridge_state.wait_for_result(&cmd_id, std::time::Duration::from_secs(12)) {
        Some(msg) => serde_json::json!({ "success": true, "message": msg }),
        None => serde_json::json!({
            "success": false,
            "message": "Perintah sudah dikirim ke Spotify, tapi respons belum kembali dalam 12 detik."
        }),
    }
}

#[tauri::command]
async fn bridge_check(app: tauri::AppHandle) -> String {
    let bridge_state = app.state::<bridge::BridgeState>().inner().clone();
    if !bridge_state.is_spicetify_connected() {
        return "offline".to_string();
    }
    let cmd_id = bridge_state.send_check();
    match bridge_state.wait_for_result(&cmd_id, std::time::Duration::from_secs(6)) {
        Some(msg) => msg,
        None => "timeout".to_string(),
    }
}

#[tauri::command]
fn get_playlist_track_state(app: tauri::AppHandle) -> serde_json::Value {
    let state = app.state::<bridge::BridgeState>();
    let (track_state, connected) = state.get_track_state_snapshot();
    serde_json::json!({
        "connected": connected,
        "track_state": track_state
    })
}

#[tauri::command]
fn bridge_status(app: tauri::AppHandle) -> serde_json::Value {
    let state = app.state::<bridge::BridgeState>();
    let pending = state.pending.lock().unwrap().is_some();
    let last = state.result.lock().unwrap().clone().map(|r| r.message);
    serde_json::json!({
        "connected": state.is_spicetify_connected(),
        "pending": pending,
        "last_result": last
    })
}

#[tauri::command]
fn set_spotify_volume(app: tauri::AppHandle, volume: f64) {
    let state = app.state::<bridge::BridgeState>();
    state.set_volume(volume);
}

#[tauri::command]
fn get_spotify_volume(app: tauri::AppHandle) -> Option<f64> {
    let state = app.state::<bridge::BridgeState>();
    state.get_volume()
}

#[tauri::command]
fn get_playlists(app: tauri::AppHandle) -> serde_json::Value {
    let state = app.state::<bridge::BridgeState>();
    let (playlists, active) = state.get_playlists_snapshot();
    serde_json::json!({
        "playlists": playlists,
        "active": active
    })
}

#[tauri::command]
fn set_target_playlist(app: tauri::AppHandle, uri: String, name: String) {
    let state = app.state::<bridge::BridgeState>();
    state.set_target_playlist(uri, name);
}

fn find_voice_script() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("voice_stt.py"));
        candidates.push(cwd.join("../voice_stt.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("voice_stt.py"));
            candidates.push(dir.join("../voice_stt.py"));
            candidates.push(dir.join("../../voice_stt.py"));
            candidates.push(dir.join("../../../voice_stt.py"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

fn run_stt(script: &std::path::Path) -> Result<String, String> {
    let attempts: Vec<(&str, Vec<String>)> = vec![
        ("python", vec![script.to_string_lossy().to_string()]),
        ("py", vec!["-3".to_string(), script.to_string_lossy().to_string()]),
    ];
    for (cmd, args) in attempts {
        match std::process::Command::new(cmd).args(&args).output() {
            Ok(out) => {
                if out.status.success() {
                    return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
                }
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let last = err.lines().last().unwrap_or("STT gagal tanpa pesan error.").to_string();
                return Err(format!(
                    "STT gagal: {}. Pastikan sudah: pip install faster-whisper sounddevice numpy",
                    last
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Python tidak ditemukan (coba 'python' / 'py').".to_string())
}

#[tauri::command]
async fn voice_command(app: tauri::AppHandle) -> serde_json::Value {
    let script = match find_voice_script() {
        Some(p) => p,
        None => {
            return serde_json::json!({
                "success": false,
                "transcribed": "",
                "message": "voice_stt.py tidak ditemukan di folder proyek. Pastikan file itu ada di folder rora-island."
            })
        }
    };
    let transcribed = match run_stt(&script) {
        Ok(t) => t,
        Err(e) => {
            return serde_json::json!({
                "success": false, "transcribed": "", "message": e
            })
        }
    };
    if transcribed.trim().is_empty() {
        return serde_json::json!({
            "success": false,
            "transcribed": "",
            "message": "Tidak terdengar perintah, coba lagi."
        });
    }
    let lower = transcribed.to_lowercase();
    let wants_add = (lower.contains("tambah")
        || lower.contains("masukkan")
        || lower.contains("masukin"))
        && lower.contains("playlist");
    if !wants_add {
        return serde_json::json!({
            "success": false,
            "transcribed": transcribed,
            "message": format!(
                "Perintah tidak dikenali: '{}'. Coba: 'Tolong tambahkan lagu ini ke playlist'.",
                transcribed
            )
        });
    }
    let track = media::get_now_playing().await;
    if !track.playing {
        return serde_json::json!({
            "success": false,
            "transcribed": transcribed,
            "message": "Tidak ada lagu yang sedang diputar di Spotify desktop."
        });
    }
    let bridge_state = app.state::<bridge::BridgeState>().inner().clone();
    if !bridge_state.is_spicetify_connected() {
        return serde_json::json!({
            "success": false,
            "transcribed": transcribed,
            "message": "Spotify desktop belum terhubung ke bridge RORA."
        });
    }
    let cmd_id = bridge_state.send_add();
    match bridge_state.wait_for_result(&cmd_id, std::time::Duration::from_secs(12)) {
        Some(msg) => serde_json::json!({
            "success": true, "transcribed": transcribed, "message": msg
        }),
        None => serde_json::json!({
            "success": false,
            "transcribed": transcribed,
            "message": "Perintah sudah dikirim ke Spotify, tapi hasil belum kembali dalam 12 detik."
        }),
    }
}

#[derive(Default)]
pub struct WakeState {
    pub child: std::sync::Mutex<Option<std::process::Child>>,
}

fn find_wake_script() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("openwakeword_listener.py"));
        candidates.push(cwd.join("../openwakeword_listener.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("openwakeword_listener.py"));
            candidates.push(dir.join("../openwakeword_listener.py"));
            candidates.push(dir.join("../../openwakeword_listener.py"));
            candidates.push(dir.join("../../../openwakeword_listener.py"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn wake_toggle(app: tauri::AppHandle, enabled: bool) -> Result<String, String> {
    let state = app.state::<WakeState>();
    if !enabled {
        if let Some(mut child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok("Wake word dimatikan.".to_string());
    }
    if state.child.lock().unwrap().is_some() {
        return Ok("Wake word sudah aktif.".to_string());
    }
    let script = match find_wake_script() {
        Some(p) => p,
        None => {
            return Err("openwakeword_listener.py tidak ditemukan di folder proyek. Pastikan file itu ada di folder rora-island.".to_string())
        }
    };
    let listener_args = vec![
        script.to_string_lossy().to_string(),
        "--threshold".to_string(),
        "0.9".to_string(),
    ];
    let attempts: Vec<(&str, Vec<String>)> = vec![
        ("py", listener_args.clone()),
        ("python", listener_args),
    ];
    let mut spawned = None;
    for (cmd, args) in attempts {
        match std::process::Command::new(cmd)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
        {
            Ok(child) => { spawned = Some(child); break; }
            Err(_) => continue,
        }
    }
    let mut child = match spawned {
        Some(c) => c,
        None => return Err("Python tidak ditemukan (coba 'py' / 'python').".to_string()),
    };
    let stdout = child.stdout.take();
    *state.child.lock().unwrap() = Some(child);
    let app2 = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        if let Some(out) = stdout {
            let reader = std::io::BufReader::new(out);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim() == "ADD" {
                    if let Some(window) = app2.get_webview_window("main") {
                        let _ = window.eval(
                            "var a=document.getElementById('roraAnswer'); \
                            if(a) a.textContent='Perintah didengar, menambahkan...'; \
                            var b=document.getElementById('btnBridgeAdd'); \
                            if(b && !b.disabled) b.click();",
                        );
                    }
                }
                if line.trim() == "WAKE" {
                    if let Some(window) = app2.get_webview_window("main") {
                        let _ = window.eval(
                            "var a=document.getElementById('roraAnswer'); \
                             if(a) a.textContent='Hey Rora terdeteksi, merekam...'; \
                             var m=document.getElementById('btnMic'); \
                             if(m && !m.disabled) m.click();",
                        );
                    }
                }
            }
        }
    });
    Ok("Wake word aktif. Ucapkan 'Hey Rora', tunggu 'Mendengarkan...', lalu ucapkan perintah.".to_string())
}

fn main() {
    // Single-instance lock: cegah RORA Island berjalan 2 kali bersamaan
    let _instance_lock = match std::net::TcpListener::bind("127.0.0.1:48899") {
        Ok(listener) => listener,
        Err(_) => {
            eprintln!("[RORA] Instance lain sudah berjalan.");
            return;
        }
    };

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    eprintln!("[RORA] Hotkey ditekan!");
                    let _ = app.emit("rora-hotkey-pressed", ());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(
                            "var a=document.getElementById('roraAnswer'); \
                            if(a) a.textContent='Hotkey diterima, merekam...'; \
                            var m=document.getElementById('btnMic'); \
                            if(m && !m.disabled) m.click();",
                        );
                    }
                }
            })
                .build(),
        )
        .manage(bridge::BridgeState::default())
        .manage(WakeState::default())
        .manage(MonitorPref(std::sync::Mutex::new(None)))
        .setup(|app| {
            let _ = set_island_size(app.handle(), false);
            let bridge_state = app.state::<bridge::BridgeState>().inner().clone();
            bridge::start_server(bridge_state);
            let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Backquote);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("[RORA] Hotkey Alt+` gagal didaftarkan: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_now_playing,
            media_toggle,
            media_next,
            media_prev,
            get_lyrics,
            set_island_mode,
            set_island_height,
            get_monitors,
            set_target_monitor,
            exit_app,
            bridge_add_now,
            bridge_check,
            get_playlist_track_state,
            bridge_status,
            set_spotify_volume,
            get_spotify_volume,
            get_playlists,
            set_target_playlist,
            voice_command,
            wake_toggle
        ])
        .run(tauri::generate_context!())
        .expect("error saat menjalankan RORA Island");
}