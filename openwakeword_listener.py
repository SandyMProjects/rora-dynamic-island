#!/usr/bin/env python3
"""RORA — Pendengar wake word "Hey Rora" via openWakeWord.

Ini MENGGANTIKAN porcupine_listener.py (dibatalkan karena sign up
Picovoice meminta company email) dan wake_word.py (Whisper).
openWakeWord tidak butuh akun, API key, atau company email apa pun:
model dilatih sendiri lewat notebook Colab, lalu jalan lokal di PC
via ONNX Runtime.

Yang kamu butuhkan (sekali saja, di luar script ini):
  1) Latih model di Google Colab (akun Google pribadi biasa sudah
     cukup, tidak ada syarat company email):
     - Buka repo openWakeWord (dscripka/openWakeWord) dan jalankan
       notebook latihan otomatisnya di Colab (versi sederhana).
     - Set target phrase menjadi "hey rora" (huruf kecil, tanpa
       tanda baca).
     - PENTING: dengarkan dulu SATU sampel hasil Piper sebelum
       generate massal. Kalau pelafalannya salah (misalnya "Rora"
       dibaca aneh oleh suara Inggris), ubah ejaannya secara fonetik
       sampai bunyinya benar, baru lanjut — ejaan yang salah di
       tahap ini akan melatih model yang salah.
     - Generate massal: beberapa ribu sampel (default notebook 1000,
       dianjurkan beberapa ribu) dengan beberapa suara Inggris dan
       variasi kecepatan, lalu jalankan training sampai keluar
       satu file .onnx.
     - Download file .onnx itu dan simpan di folder yang sama
       dengan script ini, dengan nama `hey_rora.onnx`.
     - Opsional tapi berdampak besar: tambahkan ~60 rekaman suaramu
       sendiri yang mengucapkan "Hey Rora" ke data latih (fine-tune)
       — ini yang paling menaikkan akurasi untuk suaramu spesifik.
  2) Instalasi (sekali saja):
         py -m pip install openwakeword sounddevice numpy
     Saat pertama jalan, openWakeWord mungkin mengunduh model
     embedding sekali — setelah itu jalan offline.

Cara kerja:
  - Baca mic lewat sounddevice dalam frame 1280 sampel (80 ms)
    @ 16 kHz mono int16 — ukuran frame yang dipakai openWakeWord.
  - Tiap frame diumpankan ke model.predict(); kalau skornya
    melewati threshold, cetak "WAKE" ke stdout. Island membaca
    baris itu dan menekan tombol mic lewat eval, lalu kamu ucapkan
    perintah seperti biasa.
  - Setelah WAKE, model di-reset dan script tidur 20 detik supaya
    tidak memicu ulang selama rekam perintah + bridge.
  - Skor di atas 0.3 dicetak ke stderr (bukan tiap frame, supaya
    terminal tidak banjir) — berguna untuk tuning threshold:
    kalau skor ucapanmu biasanya 0.4 tapi threshold 0.5, turunkan
    threshold; kalau suara lain sering skor 0.6, naikkan.

Threshold (default 0.5, bisa diubah lewat --threshold):
  Lebih tinggi = lebih ketat (lebih jarang salah picu, tapi lebih
  sering kelewatan). Lebih rendah = lebih peka (lebih jarang
  kelewatan, tapi lebih sering salah picu). Mulai dari 0.5.
"""
import argparse
import os
import queue
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--model", type=str, default="hey_rora.onnx")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = args.model
    if not os.path.isabs(model_path):
        model_path = os.path.join(script_dir, model_path)
    if not os.path.exists(model_path):
        print(
            f"[oww] Model tidak ditemukan: {model_path}. "
            "Latih dulu di Colab dan simpan sebagai hey_rora.onnx di folder script.",
            file=sys.stderr,
        )
        return 2

    try:
        import numpy as np
        import sounddevice as sd
    except Exception as e:  # noqa: BLE001
        print(f"[oww] sounddevice/numpy gagal: {e}", file=sys.stderr)
        return 2
    try:
        from openwakeword.model import Model
    except Exception as e:  # noqa: BLE001
        print(f"[oww] openwakeword gagal diimpor: {e}", file=sys.stderr)
        return 2

    try:
        try:
            model = Model(wakeword_model_paths=[model_path])
        except TypeError:
            # Versi lama openWakeWord memakai nama argumen ini.
            model = Model(wakeword_models=[model_path])
    except Exception as e:  # noqa: BLE001
        print(f"[oww] Gagal memuat model: {e}", file=sys.stderr)
        return 2

    model_key = os.path.splitext(os.path.basename(model_path))[0]
    print(
        f"[oww] Mendengarkan 'Hey Rora' (model {os.path.basename(model_path)}, "
        f"threshold {args.threshold}, frame 1280 @ 16 kHz)...",
        file=sys.stderr,
    )
    print("READY", flush=True)

    audio_queue = queue.Queue()

    def callback(indata, frames, time_info, status):
        if status:
            print(f"[oww] status stream: {status}", file=sys.stderr)
        try:
            audio_queue.put_nowait(bytes(indata))
        except queue.Full:
            pass

    try:
        with sd.InputStream(
            samplerate=16000,
            channels=1,
            dtype="int16",
            blocksize=1280,
            callback=callback,
        ):
            while True:
                pcm_bytes = audio_queue.get()
                pcm = np.frombuffer(pcm_bytes, dtype=np.int16)
                if len(pcm) != 1280:
                    continue
                try:
                    prediction = model.predict(pcm)
                except Exception as e:  # noqa: BLE001
                    print(f"[oww] predict gagal: {e}", file=sys.stderr)
                    continue
                # prediction adalah dict {nama_model: skor}
                score = 0.0
                if isinstance(prediction, dict):
                    if model_key in prediction:
                        score = float(prediction[model_key])
                    elif prediction:
                        score = float(max(prediction.values()))
                if score > 0.3:
                    print(f"[oww] skor: {score:.3f}", file=sys.stderr)
                if score >= args.threshold:
                    print("WAKE", flush=True)
                    print(f"[oww] WAKE terdeteksi: Hey Rora (skor {score:.3f})", file=sys.stderr)
                    try:
                        model.reset()
                    except Exception:  # noqa: BLE001
                        pass
                    time.sleep(20)
                    # Selama tidur 20 detik, mic tetap merekam dan frame
                    # menumpuk di antrean. Buang semuanya supaya deteksi
                    # berikutnya tidak tertinggal: tanpa ini, WAKE yang
                    # tercetak bisa berasal dari ucapan 20 detik yang lalu.
                    while True:
                        try:
                            audio_queue.get_nowait()
                        except queue.Empty:
                            break
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
