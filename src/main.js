const $ = (id) => document.getElementById(id);

let currentKey = "";
let lyricLines = [];
let lyricMode = "none"; // synced | plain | not_found | instrumental
let lastPosition = 0;
let demoMode = false;
let demoPosition = 0;

const DEMO_TRACK = {
  playing: true,
  title: "Demo — RORA Island",
  artist: "Mode preview browser",
  album: "",
  source: "demo",
  position_secs: 0,
  duration_secs: 187,
  is_playing: true,
};
const DEMO_LRC = `[00:05.00]Ini mode demo di browser
[00:10.00]Jalankan lewat Tauri di Windows untuk lagu asli
[00:15.00]Judul dibaca dari SMTC Spotify desktop
[00:20.00]Lirik synced akan menyala mengikuti posisi lagu`;

const ICO = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M9 16.2l-3.5-3.5L4 14.2 9 19.2 20 8.2l-1.4-1.4z"/></svg>',
  volHigh: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  volLow: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
  volMute: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
};

function setPlayIcon(el, playing) {
  if (el) el.innerHTML = playing ? ICO.pause : ICO.play;
}
function setAddIcon(el, inPlaylist) {
  if (el) el.innerHTML = inPlaylist ? ICO.check : ICO.plus;
}

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || "").split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const m of tags) {
      const fraction = m[3] ? Number(`0.${m[3]}`) : 0;
      const time = Number(m[1]) * 60 + Number(m[2]) + fraction;
      out.push({ time, text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function trackIsPlaying(t) {
  if (typeof t?.is_playing === "boolean") return t.is_playing;
  if (typeof t?.playing === "boolean") return t.playing;
  return false;
}

async function invoke(name, args) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || !core.invoke) throw new Error("Tauri tidak tersedia");
  return core.invoke(name, args);
}

function renderTrack(t) {
  $("title").textContent = t.title || "Tidak ada lagu";
  $("artist").textContent = t.artist || "Putar Spotify desktop…";
  $("sourceLabel").textContent = t.source ? `${t.source} • SMTC` : "SMTC • lokal";
  const playing = trackIsPlaying(t);
  setPlayIcon($("btnPlay"), playing);
  setPlayIcon($("btnPlay2"), playing);
  setPlayIcon($("btnPlayPaused"), false);
  $("timeTotal").textContent = fmt(t.duration_secs);
  $("timeTotMini").textContent = fmt(t.duration_secs);
  $("musicClock").textContent = jamPendek();
  $("musicDate").textContent = tglIndo(new Date());
  syncWakeUI();
  $("cover").classList.toggle("playing", playing);
  ipSync(t);
}

const HARI = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"];
const BULAN = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

let baseMode = "home";
let lyricsOpen = false;
let playlistPickerOpen = false;
let islandMenuOpen = false;
let appliedMode = "";

// Timer auto-kembali ke mode utama setelah 5 menit dalam keadaan pause
const PAUSE_IDLE_HOME_MS = 5 * 60 * 1000;
let pausedSinceMs = 0;
let pausedTrackKey = "";

function jamPendek() {
  const now = new Date();
  return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
}

function tglIndo(now) {
  return HARI[now.getDay()] + ", " + now.getDate() + " " + BULAN[now.getMonth()] + " " + now.getFullYear();
}

function syncWakeUI() {
  const on = $("btnWake").textContent.includes("ON");
  for (const id of ["btnWakeHome", "btnWakeMusic", "btnWakePaused"]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle("wake-on", on);
    b.style.opacity = on ? "1" : ".55";
  }
}

/* ---- Hover-expand ---- */
let hovered = false;
let hoverTimer = null;
let dwellTimer = null;
let mouseInside = false;

function setHovered(v) {
  if (v) {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (!mouseInside || hovered) return;
      hovered = true;
      applyMode();
    }, 120);
    return;
  }
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (!mouseInside && hovered) {
      hovered = false;
      playlistPickerOpen = false;
      islandMenuOpen = false;
      applyMode();
    }
  }, 170);
}

function currentMode() {
  if (notifyActive) return "notify";
  if (lyricsOpen && baseMode === "music") return "lyrics";
  return baseMode;
}

function closeLyrics() {
  if (!lyricsOpen) return;
  lyricsOpen = false;
  $("btnLyricsM").classList.remove("active");
}

function closePlaylistPicker() {
  if (!playlistPickerOpen) return;
  playlistPickerOpen = false;
}

function closeIslandMenu() {
  if (!islandMenuOpen) return;
  islandMenuOpen = false;
}

function updateHome() {
  $("homeClock").textContent = jamPendek();
  $("homeDate").textContent = tglIndo(new Date());
  syncWakeUI();
}

function updatePaused(t) {
  $("pausedClock").textContent = jamPendek();
  $("pausedDate").textContent = tglIndo(new Date());
  $("pausedTrackTitle").textContent = t.title || "";
  $("pausedTrackArtist").textContent = t.artist || "";
  setPlayIcon($("btnPlayPaused"), false);
  syncWakeUI();
}

// ---- Mesin progress hemat daya (hanya aktif saat mode music) ----
let ipAnchorPos = 0;
let ipAnchorPerf = 0;
let ipDur = 0;
let ipPlaying = false;
let ipRate = 1;
let ipTrackKey = "";
let ipReady = false;
let ipPausedAtWall = 0;

const SEEK_SNAP_SECS = 3;
const STEER_WINDOW_SECS = 2;

const elFillMini = $("progressMiniFill");
const elFill = $("progressFill");
const elCurMini = $("timeCurMini");
const elCur = $("timeCurrent");
for (const el of [elFillMini, elFill]) {
  el.style.width = "100%";
  el.style.transformOrigin = "left center";
  el.style.transform = "scaleX(0)";
}

function clampPos(v) {
  const s = Math.max(0, Number(v) || 0);
  return ipDur > 0 ? Math.min(s, ipDur) : s;
}

function ipEstimate(nowPerf) {
  if (!ipReady) return 0;
  const el = ipPlaying ? Math.max(0, nowPerf - ipAnchorPerf) / 1000 : 0;
  return clampPos(ipAnchorPos + el * ipRate);
}

function getTrackIdentity(t) {
  return [
    t.source || "",
    t.track_uri || t.uri || "",
    t.title || "",
    t.artist || "",
    t.album || "",
    Math.round(Number(t.duration_secs) || 0),
  ].join("|||");
}

function ipSync(t) {
  const nowPerf = performance.now();
  const raw = Math.max(0, Number(t.position_secs) || 0);
  const dur = Math.max(0, Number(t.duration_secs) || 0);
  const playing = trackIsPlaying(t);
  const key = getTrackIdentity(t);
  const updMs = Number(t.position_updated_at_ms);

  let age = 0;
  if (playing && updMs > 0) {
    if (updMs > ipPausedAtWall) age = Math.min(Math.max(0, Date.now() - updMs), 10000) / 1000;
  }
  const snap = dur > 0 ? Math.min(raw + age, dur) : raw + age;

  const changed = !ipReady || key !== ipTrackKey || playing !== ipPlaying;
  ipDur = dur;
  ipTrackKey = key;

  if (changed) {
    if (playing && !ipPlaying && ipReady) {
      ipAnchorPos = clampPos(ipAnchorPos);
    } else if (!playing && ipPlaying) {
      ipPausedAtWall = Date.now();
      ipAnchorPos = ipEstimate(nowPerf);
    } else {
      ipAnchorPos = snap;
    }
    ipAnchorPerf = nowPerf;
    ipRate = 1;
    ipPlaying = playing;
    ipReady = true;
    return;
  }

  if (!playing) return;

  const est = ipEstimate(nowPerf);
  const delta = snap - est;
  ipAnchorPos = est;
  ipAnchorPerf = nowPerf;
  if (Math.abs(delta) >= SEEK_SNAP_SECS) {
    ipAnchorPos = snap;
    ipRate = 1;
  } else {
    ipRate = 1 + Math.max(-0.25, Math.min(0.5, delta / STEER_WINDOW_SECS));
  }
}

let lastPaintedSec = -1;
let lastPaintedFrac = -1;

function paintPosition(pos) {
  lastPosition = pos;
  const frac = ipDur > 0 ? Math.min(1, Math.max(0, pos / ipDur)) : 0;
  if (Math.abs(frac - lastPaintedFrac) >= 0.0005 || frac === 0 || frac === 1) {
    lastPaintedFrac = frac;
    const sx = "scaleX(" + frac.toFixed(4) + ")";
    elFillMini.style.transform = sx;
    elFill.style.transform = sx;
    const hair = $("progressHairlineFill");
    if (hair) hair.style.transform = sx;
  }
  const sec = Math.floor(pos);
  if (sec !== lastPaintedSec) {
    lastPaintedSec = sec;
    const s = fmt(pos);
    elCurMini.textContent = s;
    elCur.textContent = s;
  }
}

let frameLoopRunning = false;
let lastHairlinePaintMs = 0;

function ensureFrameLoop() {
  if (!frameLoopRunning && baseMode === "music") {
    frameLoopRunning = true;
    requestAnimationFrame(frame);
  }
}

function frame(nowPerf) {
  if (baseMode !== "music") {
    frameLoopRunning = false;
    return;
  }
  requestAnimationFrame(frame);

  // Saat collapsed tanpa lirik, hemat GPU dengan update hairline ~5fps
  if (!hovered && !lyricsOpen) {
    if (nowPerf - lastHairlinePaintMs < 200) return;
    lastHairlinePaintMs = nowPerf;
  }
  paintPosition(ipEstimate(nowPerf));
  updateLyricHighlight();
}

let lastActiveIdx = -1;
const LYRIC_ADVANCE_SECS = 0.25;

function lyricActiveIdx() {
  const t = lastPosition + LYRIC_ADVANCE_SECS;
  let ai = -1;
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].time <= t) ai = i;
  }
  return ai;
}

function renderLyricWindow() {
  const linesEl = $("lyricsLines");
  linesEl.innerHTML = "";
  const ai = lyricActiveIdx();
  lastActiveIdx = ai;
  if (ai < 0) {
    if (lyricLines.length) {
      const div = document.createElement("div");
      div.className = "lyric-line next";
      div.textContent = lyricLines[0].text;
      linesEl.appendChild(div);
    }
    return;
  }
  const active = document.createElement("div");
  active.className = "lyric-line active";
  active.textContent = lyricLines[ai].text;
  linesEl.appendChild(active);
  if (ai + 1 < lyricLines.length) {
    const next = document.createElement("div");
    next.className = "lyric-line next";
    next.textContent = lyricLines[ai + 1].text;
    linesEl.appendChild(next);
  }
}

function updateLyricHighlight() {
  if (lyricMode !== "synced" || !lyricLines.length) return;
  if (lyricActiveIdx() !== lastActiveIdx) renderLyricWindow();
}

let appliedSize = "";

async function applyMode() {
  if (baseMode !== "music" || !hovered) {
    playlistPickerOpen = false;
  }
  if (!hovered) {
    islandMenuOpen = false;
  }
  const m = currentMode();
  const showLyrics = m === "lyrics";
  const showNotify = m === "notify";
  const showHover = hovered || showNotify;
  const showPlaylistDrawer = !showNotify && baseMode === "music" && hovered && playlistPickerOpen;
  const showSysMenu = !showNotify && hovered && islandMenuOpen;

  document.body.classList.toggle("lyrics-on", showLyrics);
  document.body.dataset.state = m;
  const island = $("island");
  if (island) {
    island.dataset.state = m;
    island.dataset.hover = showHover ? "true" : "false";
    island.dataset.lyrics = showLyrics ? "true" : "false";
    island.dataset.playlistOpen = showPlaylistDrawer ? "true" : "false";
    island.dataset.menuOpen = showSysMenu ? "true" : "false";
  }
  $("homeView").style.display = !showNotify && baseMode === "home" ? "flex" : "none";
  $("musicView").style.display = !showNotify && baseMode === "music" ? "flex" : "none";
  $("pausedView").style.display = !showNotify && baseMode === "paused" ? "flex" : "none";
  const drop = $("lyricsDrop");
  if (drop) drop.style.display = !showNotify && showLyrics ? "flex" : "none";
  notifyView.style.display = showNotify ? "flex" : "none";
  if (showNotify) { requestAnimationFrame(fitNotifyHeight); appliedMode = m; return; }
  appliedMode = m;

  let sizeMode;
  if (baseMode === "home") {
    sizeMode = hovered ? "home-expanded" : "home";
  } else if (baseMode === "music") {
    if (showLyrics) {
      sizeMode = hovered
        ? (showPlaylistDrawer ? "music-lyrics-hover-playlist" : "music-lyrics-hover")
        : "music-lyrics";
    } else {
      sizeMode = hovered
        ? (showPlaylistDrawer ? "music-hover-playlist" : "music-hover")
        : "music";
    }
  } else {
    sizeMode = hovered ? "paused-hover" : "paused";
  }
  if (showSysMenu) {
    sizeMode += "-menu";
  }

  if (sizeMode === appliedSize) return;
  appliedSize = sizeMode;
  try { await invoke("set_island_mode", { mode: sizeMode }); } catch (e) {}
}

// ---- Notifikasi RORA ----
let notifyActive = false;
let notifyTimer = null;
const NOTIFY_IDLE_MS = 8000;

const notifyView = $("notifyView");
const notifyText = $("notifyText");
notifyView.addEventListener("click", (e) => {
  e.stopPropagation();
  cancelNotify();
  applyMode();
});

function cancelNotify() {
  notifyActive = false;
  $("island").classList.remove("notify-flash");
  appliedSize = "";
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
}

function notifyRora(text) {
  notifyText.textContent = text;
  notifyActive = true;
  playlistPickerOpen = false;
  islandMenuOpen = false;
  notifyView.classList.remove("notify-in");
  void notifyView.offsetWidth;
  notifyView.classList.add("notify-in");
  $("island").classList.add("notify-flash");
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    notifyActive = false;
    cancelNotify();
    applyMode();
  }, NOTIFY_IDLE_MS);
  applyMode();
}

function fitNotifyHeight() {
  if (!notifyActive) return;
  const textH = notifyText ? notifyText.offsetHeight : 20;
  const h = Math.min(104, Math.max(44, textH + 22));
  invoke("set_island_height", { h }).catch(() => {});
}

$("island").addEventListener("mouseenter", () => { mouseInside = true; setHovered(true); });
$("island").addEventListener("mouseleave", () => { mouseInside = false; setHovered(false); });
$("island").addEventListener("focusin", () => { mouseInside = true; setHovered(true); });
$("island").addEventListener("focusout", (e) => {
  if (!$("island").contains(e.relatedTarget)) {
    mouseInside = false;
    setHovered(false);
  }
});

// ---- Menu Klik Kanan (Monitor & Keluar) ----
let monitorInfo = { count: 1, current_index: 0, monitors: [] };

async function syncMonitorButton() {
  try {
    const info = await invoke("get_monitors");
    if (!info || typeof info.count !== "number") return;
    monitorInfo = info;
    const btn = $("btnSwitchMonitor");
    const label = $("switchMonitorLabel");
    if (!btn || !label) return;
    if (info.count > 1) {
      const nextIdx = (info.current_index + 1) % info.count;
      btn.style.display = "inline-flex";
      label.textContent = `Monitor ${nextIdx + 1}`;
      btn.title = `Pindah ke Monitor ${nextIdx + 1}`;
    } else {
      btn.style.display = "none";
    }
  } catch (_) {}
}

$("island").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (notifyActive) {
    cancelNotify();
  }
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  mouseInside = true;
  hovered = true;
  islandMenuOpen = !islandMenuOpen;
  if (islandMenuOpen) {
    closePlaylistPicker();
    void syncMonitorButton();
  }
  void applyMode();
});

const elBtnSwitchMonitor = $("btnSwitchMonitor");
if (elBtnSwitchMonitor) {
  elBtnSwitchMonitor.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (monitorInfo.count <= 1) return;
    const nextIdx = (monitorInfo.current_index + 1) % monitorInfo.count;
    try {
      const msg = await invoke("set_target_monitor", { index: nextIdx });
      await syncMonitorButton();
      notifyRora(msg);
    } catch (err) {
      notifyRora(`Gagal pindah monitor: ${err}`);
    }
  });
}

async function exitRoraApp(e) {
  if (e) e.stopPropagation();
  try {
    await invoke("exit_app");
  } catch (_) {
    window.close();
  }
}

const elBtnExitApp = $("btnExitApp");
if (elBtnExitApp) elBtnExitApp.addEventListener("click", exitRoraApp);

const elBtnExitHome = $("btnExitHome");
if (elBtnExitHome) elBtnExitHome.addEventListener("click", exitRoraApp);

void syncMonitorButton();

window.roraTestNotify = () => notifyRora("Tes notifikasi — RORA tampil full di pill.");

$("cover").innerHTML = '<div class="rora-eq"><span></span><span></span><span></span><span></span><span></span></div>';

function renderLyrics() {
  const linesEl = $("lyricsLines");
  const plainEl = $("lyricsPlain");
  const emptyEl = $("lyricsEmpty");
  linesEl.innerHTML = "";
  plainEl.style.display = "none";
  emptyEl.style.display = "none";
  if (lyricMode === "synced") {
    linesEl.style.display = "block";
    renderLyricWindow();
  } else if (lyricMode === "plain") {
    linesEl.style.display = "none";
    plainEl.style.display = "block";
  } else if (lyricMode === "instrumental") {
    linesEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.textContent = "Lagu instrumental — tidak ada lirik.";
  } else {
    linesEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.textContent = "Lirik tidak ditemukan.";
  }
}

async function fetchLyrics(t) {
  const key = t.track_uri || t.uri || `${t.title}|||${t.artist}|||${t.album || ""}|||${Math.round(Number(t.duration_secs) || 0)}`;
  if (key === currentKey) return;
  currentKey = key;
  lastActiveIdx = -1;
  lyricLines = [];
  lyricMode = "none";
  $("lyricsPlain").textContent = "";
  renderLyrics();
  if (!t.title) return;
  try {
    const res = await invoke("get_lyrics", {
      title: t.title,
      artist: t.artist,
      durationSecs: t.duration_secs || 0,
    });
    if (currentKey !== key) return;
    if (res?.synced_lrc) {
      lyricLines = parseLrc(res.synced_lrc);
      lyricMode = lyricLines.length ? "synced" : (res.plain ? "plain" : "not_found");
      if (lyricMode === "plain") $("lyricsPlain").textContent = res.plain || "";
    } else if (res?.plain) {
      lyricMode = "plain";
      $("lyricsPlain").textContent = res.plain;
    } else if (res?.kind === "instrumental") {
      lyricMode = "instrumental";
    } else {
      lyricMode = "not_found";
    }
  } catch (e) {
    if (currentKey !== key) return;
    lyricMode = "not_found";
    notifyRora(`Gagal ambil lirik: ${e}`);
  }
  if (currentKey === key) renderLyrics();
}

// ---- Pemilih & Indikator Playlist (Event-Driven Push) ----
let activePlaylist = {
  uri: "",
  name: "My Playlist",
};
let availablePlaylists = [activePlaylist];
let lastPlaylistListSignature = "";
let playlistSelectIgnoreSyncUntil = 0;

let playlistState = "idle";
let lastPlaylistTrack = null;
let expectedTrackStartedAt = 0;
let fallbackCheckTriggeredFor = "";
let fallbackCheckInFlight = false;
let optimisticInForKey = "";

let lastPlaylistsSyncAt = 0;
let lastTrackStateSyncAt = 0;
let lastObservedTrackId = "";

function normalizeTitle(str) {
  return String(str || "").trim().toLowerCase();
}

function playlistTrackKey(t) {
  return [
    activePlaylist?.uri || "",
    t?.track_uri || t?.uri || "",
    normalizeTitle(t?.title),
    normalizeTitle(t?.artist),
  ].join("|||");
}

function setPlaylistIndicatorState(state, customReason = "") {
  const indicator = $("playlistIndicator");
  const mark = $("playlistIndicatorMark");
  const label = $("playlistIndicatorText");
  const button = $("btnBridgeAdd");
  const plName = activePlaylist?.name || "playlist";
  const config = {
    checking: {
      mark: "·",
      label: `Cek ${plName}…`,
      title: `Memeriksa lagu di ${plName}`
    },
    in: {
      mark: "✓",
      label: `Sudah di ${plName}`,
      title: `Lagu sudah ada di ${plName}`
    },
    out: {
      mark: "+",
      label: `Belum di ${plName}`,
      title: `Lagu belum ada di ${plName}`
    },
    offline: {
      mark: "·",
      label: "Spotify bridge offline",
      title: "Spotify desktop belum terhubung ke bridge RORA. Pastikan Spotify terbuka dan Spicetify aktif."
    },
    error: {
      mark: "!",
      label: "Gagal cek playlist",
      title: customReason || "Terjadi kesalahan saat memeriksa isi playlist di Spotify."
    },
    idle: {
      mark: "·",
      label: plName,
      title: "Menunggu pemutaran lagu"
    },
  };
  const item = config[state] || config.error;
  playlistState = state;
  if (indicator) {
    indicator.dataset.state = state;
    indicator.title = customReason || item.title;
  }
  if (mark) mark.textContent = item.mark;
  if (label) label.textContent = item.label;
  if (button) {
    setAddIcon(button, state === "in");
    button.title = state === "in"
      ? `Sudah di ${plName} • Tahan untuk ganti playlist`
      : `Klik: tambah ke ${plName} • Tahan: ganti playlist`;
    button.setAttribute("aria-label", button.title);
  }
}

function markTrackInPlaylist() {
  if (!lastPlaylistTrack) return;
  optimisticInForKey = playlistTrackKey(lastPlaylistTrack);
  setPlaylistIndicatorState("in");
}

async function triggerFallbackCheck(key) {
  if (fallbackCheckInFlight) return;
  fallbackCheckInFlight = true;
  try {
    const res = await invoke("bridge_check");
    if (playlistTrackKey(lastPlaylistTrack) !== key) return;
    if (res === "offline") {
      setPlaylistIndicatorState("offline");
    } else if (res === "in" || res === "out") {
      setPlaylistIndicatorState(res);
    }
  } catch (_) {
  } finally {
    fallbackCheckInFlight = false;
  }
}

async function syncTrackPlaylistState(t) {
  if (!t?.title) {
    lastPlaylistTrack = null;
    optimisticInForKey = "";
    setPlaylistIndicatorState("idle");
    return;
  }

  const prevKey = lastPlaylistTrack ? playlistTrackKey(lastPlaylistTrack) : "";
  lastPlaylistTrack = t;
  const key = playlistTrackKey(t);

  if (key !== prevKey) {
    expectedTrackStartedAt = Date.now();
    fallbackCheckTriggeredFor = "";
    if (optimisticInForKey !== key) {
      optimisticInForKey = "";
      setPlaylistIndicatorState("checking");
    }
  }

  if (optimisticInForKey === key) {
    if (playlistState !== "in") setPlaylistIndicatorState("in");
    return;
  }

  try {
    const snap = await invoke("get_playlist_track_state");
    if (playlistTrackKey(lastPlaylistTrack) !== key) return;

    const connected = Boolean(snap?.connected);
    const ts = snap?.track_state;

    if (!connected) {
      if (playlistState !== "offline") setPlaylistIndicatorState("offline");
      return;
    }

    if (ts && ts.playlist_uri === activePlaylist?.uri) {
      const titleMatches =
        !ts.track_title ||
        normalizeTitle(ts.track_title) === normalizeTitle(t.title);
      const uriMatches =
        !t.track_uri ||
        !ts.track_uri ||
        ts.track_uri === t.track_uri;

      if (titleMatches && uriMatches && ts.state !== "idle") {
        if (ts.state === "in" || ts.state === "out") {
          if (playlistState !== ts.state) {
            setPlaylistIndicatorState(ts.state, ts.reason || "");
          }
          return;
        }
        if (ts.state === "error") {
          setPlaylistIndicatorState("error", ts.reason || "");
          return;
        }
      }
    }

    if (playlistState === "offline") {
      setPlaylistIndicatorState("checking");
    }
    if (
      Date.now() - expectedTrackStartedAt > 2500 &&
      fallbackCheckTriggeredFor !== key
    ) {
      fallbackCheckTriggeredFor = key;
      void triggerFallbackCheck(key);
    }
  } catch (_) {}
}

function renderPlaylistList() {
  const listEl = $("playlistList");
  if (!listEl) return;
  listEl.innerHTML = "";

  for (const pl of availablePlaylists) {
    const isSelected = pl.uri === activePlaylist?.uri;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "playlist-item" + (isSelected ? " active" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isSelected ? "true" : "false");

    const nameSpan = document.createElement("span");
    nameSpan.className = "playlist-item-name";
    nameSpan.textContent = pl.name;
    item.appendChild(nameSpan);

    if (isSelected) {
      const checkSpan = document.createElement("span");
      checkSpan.className = "playlist-item-check";
      checkSpan.textContent = "✓";
      item.appendChild(checkSpan);
    }

    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      activePlaylist = { uri: pl.uri, name: pl.name };
      playlistSelectIgnoreSyncUntil = Date.now() + 1500;
      lastPlaylistListSignature = "";
      optimisticInForKey = "";
      expectedTrackStartedAt = Date.now();
      fallbackCheckTriggeredFor = "";
      lastTrackStateSyncAt = 0;
      renderPlaylistList();

      closePlaylistPicker();
      await applyMode();

      setPlaylistIndicatorState("checking");
      try {
        await invoke("set_target_playlist", { uri: pl.uri, name: pl.name });
      } catch (_) {}
    });

    listEl.appendChild(item);
  }
}

renderPlaylistList();

async function syncPlaylists() {
  if (Date.now() < playlistSelectIgnoreSyncUntil) return;
  try {
    const data = await invoke("get_playlists");
    const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
    const active = data?.active;
    if (!playlists.length) return;

    const sig = playlists.map((p) => `${p.uri}:${p.name}`).join("|") + "::" + (active?.uri || "");
    if (sig === lastPlaylistListSignature) return;
    lastPlaylistListSignature = sig;

    availablePlaylists = playlists;
    const chosen = active && playlists.some((p) => p.uri === active.uri)
      ? active
      : playlists[0];

    const changedActive = chosen.uri !== activePlaylist.uri;
    activePlaylist = { uri: chosen.uri, name: chosen.name };
    renderPlaylistList();

    if (changedActive && lastPlaylistTrack) {
      optimisticInForKey = "";
      expectedTrackStartedAt = Date.now();
      fallbackCheckTriggeredFor = "";
      lastTrackStateSyncAt = 0;
      setPlaylistIndicatorState("checking");
    } else {
      setPlaylistIndicatorState(playlistState);
    }
  } catch (_) {}
}

// ---- Kontrol Volume Internal Spotify ----
let currentVolPct = 100;
let lastNonZeroVolPct = 60;
let volIgnoreSyncUntil = 0;
let volSendTimer = null;
let volPendingPct = null;

function paintVolumeUI(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  currentVolPct = clamped;
  if (clamped > 0) lastNonZeroVolPct = clamped;

  const slider = $("spotifyVolume");
  const text = $("spotifyVolText");
  const btn = $("btnMuteMusic");
  if (slider) {
    slider.value = String(clamped);
    slider.style.setProperty("--vol-pct", `${clamped}%`);
  }
  if (text) text.textContent = `${clamped}%`;
  if (btn) {
    btn.innerHTML = clamped === 0 ? ICO.volMute : clamped < 50 ? ICO.volLow : ICO.volHigh;
    btn.title = clamped === 0 ? "Unmute Spotify" : "Mute Spotify";
  }
}

function sendSpotifyVolume(pct, immediate = false) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  paintVolumeUI(clamped);
  volIgnoreSyncUntil = Date.now() + 1000;
  volPendingPct = clamped;

  const flush = () => {
    volSendTimer = null;
    if (volPendingPct === null) return;
    const toSend = volPendingPct / 100;
    volPendingPct = null;
    invoke("set_spotify_volume", { volume: toSend }).catch(() => {});
  };

  if (immediate) {
    if (volSendTimer) { clearTimeout(volSendTimer); volSendTimer = null; }
    flush();
  } else if (!volSendTimer) {
    volSendTimer = setTimeout(flush, 75);
  }
}

async function syncSpotifyVolume() {
  if (Date.now() < volIgnoreSyncUntil) return;
  try {
    const vol = await invoke("get_spotify_volume");
    if (typeof vol === "number" && isFinite(vol) && Date.now() >= volIgnoreSyncUntil) {
      paintVolumeUI(vol * 100);
    }
  } catch (_) {}
}

paintVolumeUI(100);

const elVolSlider = $("spotifyVolume");
if (elVolSlider) {
  elVolSlider.addEventListener("input", (e) => {
    e.stopPropagation();
    sendSpotifyVolume(e.target.value, false);
  });
  elVolSlider.addEventListener("change", (e) => {
    e.stopPropagation();
    sendSpotifyVolume(e.target.value, true);
  });
}

const elMuteBtn = $("btnMuteMusic");
if (elMuteBtn) {
  elMuteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nextPct = currentVolPct > 0 ? 0 : (lastNonZeroVolPct || 50);
    sendSpotifyVolume(nextPct, true);
  });
}

const elVolumeRow = $("volumeRow");
if (elVolumeRow) {
  elVolumeRow.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const step = e.deltaY < 0 ? 5 : -5;
    sendSpotifyVolume(currentVolPct + step, false);
  }, { passive: false });
}

let refreshInFlight = false;

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    let track = null;
    try {
      track = await invoke("get_now_playing");
    } catch (e) {
      if (!demoMode) {
        demoMode = true;
        currentKey = "";
        lyricLines = parseLrc(DEMO_LRC);
        lyricMode = "synced";
      }
      demoPosition += 1;
      if (demoPosition > DEMO_TRACK.duration_secs) demoPosition = 0;
      track = { ...DEMO_TRACK, position_secs: demoPosition };
    }

    const sourceId = String(track?.source || "").toLowerCase();
    const isSpotifyTrack = sourceId.includes("spotify") || (demoMode && sourceId === "demo");
    const hasTrack = Boolean(track && (track.title || track.artist) && isSpotifyTrack);

    let goHomeFromIdlePause = false;
    if (!hasTrack) {
      pausedSinceMs = 0;
      pausedTrackKey = "";
      lastObservedTrackId = "";
    } else {
      const isPlaying = trackIsPlaying(track);
      const trackKey = getTrackIdentity(track);
      if (trackKey !== lastObservedTrackId) {
        lastObservedTrackId = trackKey;
        lastTrackStateSyncAt = 0;
      }
      if (isPlaying) {
        pausedSinceMs = 0;
        pausedTrackKey = "";
      } else {
        if (pausedSinceMs === 0 || pausedTrackKey !== trackKey) {
          pausedSinceMs = Date.now();
          pausedTrackKey = trackKey;
        } else if (Date.now() - pausedSinceMs >= PAUSE_IDLE_HOME_MS) {
          goHomeFromIdlePause = true;
        }
      }
    }

    if (!hasTrack || goHomeFromIdlePause) {
      const enteredHome = baseMode !== "home";
      baseMode = "home";
      ipReady = false;
      ipPlaying = false;
      ipRate = 1;
      ipDur = 0;
      ipAnchorPos = 0;
      ipAnchorPerf = performance.now();
      ipPausedAtWall = 0;
      paintPosition(0);
      updateHome();
      closeLyrics();
      closePlaylistPicker();
      if (enteredHome) cancelNotify();
      if (currentKey !== "") {
        currentKey = "";
        lyricLines = [];
        lyricMode = "none";
        lastActiveIdx = -1;
        renderLyrics();
      }
    } else {
      const prevMode = baseMode;
      baseMode = trackIsPlaying(track) ? "music" : "paused";
      if (baseMode === "paused" && prevMode !== "paused") {
        closeLyrics();
        closePlaylistPicker();
      }
      if (baseMode === "paused") updatePaused(track);
    }

    await applyMode();
    if (hasTrack && !goHomeFromIdlePause) {
      renderTrack(track);
      ensureFrameLoop();
      if (baseMode === "paused") {
        paintPosition(ipEstimate(performance.now()));
      }

      const now = Date.now();
      if (playlistPickerOpen || now - lastPlaylistsSyncAt > 5000) {
        lastPlaylistsSyncAt = now;
        void syncPlaylists();
      }
      if (now - lastTrackStateSyncAt > 1500) {
        lastTrackStateSyncAt = now;
        void syncTrackPlaylistState(track);
      }
      void fetchLyrics(track);
      if (hovered) {
        void syncSpotifyVolume();
      }
    }
  } catch (e) {
    $("status").textContent = `Gagal memperbarui status Spotify: ${e}`;
  } finally {
    refreshInFlight = false;
  }
}

function toggleLyrics() {
  if (baseMode !== "music") { closeLyrics(); applyMode(); return; }
  lyricsOpen = !lyricsOpen;
  if (lyricsOpen) closePlaylistPicker();
  $("btnLyricsM").classList.toggle("active", lyricsOpen);
  cancelNotify();
  applyMode();
}

$("btnLyricsM").addEventListener("click", (e) => { e.stopPropagation(); toggleLyrics(); });

async function togglePlay() {
  try { await invoke("media_toggle"); } catch (e) {}
  setTimeout(refresh, 350);
}

$("btnPlay").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
$("btnPlay2").addEventListener("click", togglePlay);
$("btnPlayPaused").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
$("btnMicHome").addEventListener("click", (e) => { e.stopPropagation(); $("btnMic").click(); });
$("btnMicMusic").addEventListener("click", (e) => { e.stopPropagation(); $("btnMic").click(); });
$("btnMicPaused").addEventListener("click", (e) => { e.stopPropagation(); $("btnMic").click(); });
$("btnWakeHome").addEventListener("click", (e) => { e.stopPropagation(); $("btnWake").click(); });
$("btnWakeMusic").addEventListener("click", (e) => { e.stopPropagation(); $("btnWake").click(); });
$("btnWakePaused").addEventListener("click", (e) => { e.stopPropagation(); $("btnWake").click(); });
$("btnPrev").addEventListener("click", async () => {
  try { await invoke("media_prev"); } catch (e) {}
  setTimeout(refresh, 350);
});
$("btnNext").addEventListener("click", async () => {
  try { await invoke("media_next"); } catch (e) {}
  setTimeout(refresh, 350);
});

// ---- Tombol + : Klik Singkat = Add, Tekan Lama (420ms) = Pilih Playlist ----
const elBridgeAdd = $("btnBridgeAdd");
let addHoldGlowTimer = null;
let addLongPressTimer = null;
let addLongPressFired = false;

function clearAddHoldTimers() {
  if (addHoldGlowTimer) { clearTimeout(addHoldGlowTimer); addHoldGlowTimer = null; }
  if (addLongPressTimer) { clearTimeout(addLongPressTimer); addLongPressTimer = null; }
  elBridgeAdd.classList.remove("holding");
}

function togglePlaylistPicker() {
  playlistPickerOpen = !playlistPickerOpen;
  if (playlistPickerOpen) {
    closeIslandMenu();
    renderPlaylistList();
    void syncPlaylists();
  }
  void applyMode();
}

elBridgeAdd.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || elBridgeAdd.disabled) return;
  e.stopPropagation();
  clearAddHoldTimers();
  addLongPressFired = false;

  addHoldGlowTimer = setTimeout(() => {
    elBridgeAdd.classList.add("holding");
  }, 90);

  addLongPressTimer = setTimeout(() => {
    addLongPressTimer = null;
    addLongPressFired = true;
    elBridgeAdd.classList.remove("holding");
    togglePlaylistPicker();
  }, 420);
});

elBridgeAdd.addEventListener("pointerup", clearAddHoldTimers);
elBridgeAdd.addEventListener("pointerleave", clearAddHoldTimers);
elBridgeAdd.addEventListener("pointercancel", clearAddHoldTimers);

elBridgeAdd.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearAddHoldTimers();
  togglePlaylistPicker();
});

elBridgeAdd.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (addLongPressFired) {
    addLongPressFired = false;
    return;
  }
  closePlaylistPicker();
  elBridgeAdd.disabled = true;
  try {
    const res = await invoke("bridge_add_now");
    notifyRora(res.message);
    if (res?.success) {
      markTrackInPlaylist();
    } else if (lastPlaylistTrack) {
      optimisticInForKey = "";
      fallbackCheckTriggeredFor = "";
      void triggerFallbackCheck(playlistTrackKey(lastPlaylistTrack));
    }
  } catch (err) {
    notifyRora(`Gagal: ${err}`);
    optimisticInForKey = "";
  }
  elBridgeAdd.disabled = false;
});

$("btnMic").addEventListener("click", async () => {
  const btn = $("btnMic");
  btn.disabled = true;
  $("island").classList.add("listening");
  notifyRora("🎤 Mendengarkan... bicara sekarang (6 detik).");
  try {
    const res = await invoke("voice_command");
    notifyRora(res.transcribed
      ? `Kamu: "${res.transcribed}" — RORA: ${res.message}`
      : `RORA: ${res.message}`);
    if (res?.success) {
      markTrackInPlaylist();
    }
  } catch (e) {
    notifyRora(`Gagal: ${e}`);
  }
  $("island").classList.remove("listening");
  btn.disabled = false;
});

try {
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev && ev.listen) {
    ev.listen("rora-hotkey-pressed", () => {
      notifyRora("Hotkey diterima, merekam...");
      const mic = $("btnMic");
      if (mic && !mic.disabled) mic.click();
    });
  }
} catch (e) {}

let wakeOn = false;
$("btnWake").addEventListener("click", async () => {
  wakeOn = !wakeOn;
  const btn = $("btnWake");
  btn.disabled = true;
  try {
    const msg = await invoke("wake_toggle", { enabled: wakeOn });
    btn.textContent = wakeOn ? "👂 Wake ON" : "👂 Wake OFF";
    syncWakeUI();
    notifyRora(msg);
  } catch (e) {
    wakeOn = false;
    btn.textContent = "👂 Wake OFF";
    syncWakeUI();
    notifyRora(`Gagal nyalakan wake word: ${e}`);
  }
  btn.disabled = false;
});

let refreshTimer = null;

function nextRefreshDelayMs() {
  if (baseMode === "music") return hovered ? 750 : 1000;
  if (baseMode === "paused") return 1500;
  return 2500;
}

function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refresh();
    scheduleNextRefresh();
  }, nextRefreshDelayMs());
}

(async () => {
  await refresh();
  scheduleNextRefresh();
})();