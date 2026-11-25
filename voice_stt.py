#!/usr/bin/env python3
"""RORA Fase 2a — Rekam mic 6 detik lalu transkripsi lokal pakai faster-whisper.

Dipakai oleh island lewat perintah suara (klik tombol mic), BUKAN oleh Discord.
Hanya mencetak hasil transkripsi ke stdout (satu baris). Log/error ke stderr.

Instal dulu (sekali):
    pip install faster-whisper sounddevice numpy
Jalankan pertama kali akan download model "tiny" (~75 MB) otomatis.
Tes manual:
    python voice_stt.py
    -> bicara "Tolong tambahkan lagu ini ke playlist" dalam 6 detik
    -> script mencetak hasil transkripsinya saja.
"""
import argparse
import os
import sys
import tempfile
import wave

import numpy as np


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--language", default="id")
    args = ap.parse_args()

    try:
        import sounddevice as sd
    except Exception as e:  # noqa: BLE001
        print(f"sounddevice belum terinstal / gagal: {e}", file=sys.stderr)
        print("Jalankan: pip install faster-whisper sounddevice numpy", file=sys.stderr)
        return 2

    sr = 16000
    print(f"Merekam {args.seconds} detik... bicara sekarang.", file=sys.stderr)
    try:
        audio = sd.rec(
            int(args.seconds * sr),
            samplerate=sr,
            channels=1,
            dtype="int16",
        )
        sd.wait()
    except Exception as e:  # noqa: BLE001
        print(f"Gagal merekam mic: {e}", file=sys.stderr)
        return 3

    # PENTING: jangan tulis wav di folder proyek, apalagi src-tauri.
    # Saat jalan lewat `npm run tauri dev`, cwd island adalah src-tauri,
    # dan Tauri dev mengawasi folder itu — file wav baru langsung memicu
    # "Rebuilding application..." dan island restart di tengah perintah
    # suara (bug yang terjadi 26 Oct 2026, 03:53). Pakai folder temp
    # sistem (%TEMP%) yang tidak diawasi siapa pun.
    wav_path = os.path.join(tempfile.gettempdir(), "rora_voice_tmp.wav")
    try:
        with wave.open(wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(audio.tobytes())
    except Exception as e:  # noqa: BLE001
        print(f"Gagal menulis wav: {e}", file=sys.stderr)
        return 4

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print(f"faster-whisper belum terinstal: {e}", file=sys.stderr)
        print("Jalankan: pip install faster-whisper sounddevice numpy", file=sys.stderr)
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            wav_path, language=args.language, beam_size=1
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
    except Exception as e:  # noqa: BLE001
        print(f"Gagal transkripsi: {e}", file=sys.stderr)
        return 5

    # Satu-satunya output ke stdout: hasil transkripsi (boleh kosong).
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
