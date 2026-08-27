#!/usr/bin/env python3
"""Helper de codificación Opus para ai-server.

Codifica WAV -> frames Opus con opuslib_next (libopus moderno), EXACTAMENTE
como el servidor xiaozhi de la china (xinnan-tech/xiaozhi-esp32-server,
core/utils/opus_encoder_utils.py):

    Encoder(sample_rate, channels, APPLICATION_AUDIO)
    bitrate = 24000
    complexity = 10

La china produce paquetes CELT 24k con 4 subframes (TOC 0xdb, framecode 3)
que el decodificador del ESP32 (esp_opus) reproduce LIMPIO.
opusscript (libopus viejo WASM) produce 1 frame por paquete (TOC 0x58)
-> el firmware genera INTERFERENCIA. Este helper es EL FIX.

Protocolo: lee el WAV por stdin, escribe los frames por stdout con
formato length-prefixed (uint16 LE), igual que el dump de la china.
"""
import sys
import os
import struct
import wave

import opuslib_next
from opuslib_next import constants

SAMPLE_RATE = 24000
FRAME_MS = 60
BITRATE = 24000
COMPLEXITY = 10

# MODO DUMP TEMPORAL (25/08 21:15): si STACKCHAN_OPUS_DUMP_MODE=1, ignora el
# WAV y sirve los frames EXACTOS capturados de la china (voz real, TOC 0xdb).
# Prueba de aislamiento: si con estos bytes suena limpio, el pipeline entrega
# bien y el problema es el contenido generado; si suena mal, es la entrega.
DUMP_MODE = os.environ.get("STACKCHAN_OPUS_DUMP_MODE") == "1"
DUMP_PATH = os.environ.get("STACKCHAN_OPUS_DUMP_PATH", "/tmp/china_frames_24s.dump")

# El venv_stackchan tiene opuslib_next instalado (dedicado, 27/08/2026) (25/08 21:05)
# Ruta: /opt/venv_stackchan/bin/python3


def encode_wav_to_frames(wav_data: bytes) -> list[bytes]:
    """Codifica un WAV completo a frames Opus (length-prefixed en stdout)."""
    # Leer WAV desde bytes
    import io
    with wave.open(io.BytesIO(wav_data), "rb") as w:
        pcm = w.readframes(w.getnframes())
        rate = w.getframerate()

    # Resamplear a 24k si hace falta (con librería pura? usamos ffmpeg para calidad)
    if rate != SAMPLE_RATE:
        import subprocess
        proc = subprocess.run(
            ["/opt/homebrew/bin/ffmpeg", "-y", "-loglevel", "error",
             "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
             "-ar", str(SAMPLE_RATE), "-ac", "1", "-sample_fmt", "s16",
             "-f", "s16le", "pipe:1"],
            input=pcm, capture_output=True, timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg resample falló: {proc.stderr[:200]}")
        pcm = proc.stdout

    frame_size = SAMPLE_RATE * FRAME_MS // 1000  # 1440 muestras = 2880 bytes

    enc = opuslib_next.Encoder(SAMPLE_RATE, 1, constants.APPLICATION_AUDIO)
    enc.bitrate = BITRATE
    enc.complexity = COMPLEXITY

    frames = []
    for i in range(0, len(pcm) - frame_size * 2 + 1, frame_size * 2):
        chunk = pcm[i:i + frame_size * 2]
        frames.append(enc.encode(chunk, frame_size))

    # Último frame incompleto -> padding con ceros (como hace el server actual)
    rem = len(pcm) % (frame_size * 2)
    if rem:
        chunk = pcm[len(pcm) - rem:] + b"\x00" * (frame_size * 2 - rem)
        frames.append(enc.encode(chunk, frame_size))

    return frames


def main():
    if DUMP_MODE:
        # Leer y descartar stdin: Node pasa el WAV por el pipe; si no lo
        # leemos, el write de Node recibe EPIPE cuando salimos (pipe roto).
        sys.stdin.buffer.read()
        # Servir los frames capturados de la china tal cual (length-prefixed)
        data = open(DUMP_PATH, "rb").read()
        out = sys.stdout.buffer
        out.write(data)
        sys.stderr.write(f"[opus_encode_helper] DUMP MODE: {len(data)}B de {DUMP_PATH}\n")
        sys.stderr.flush()
        return
    wav_data = sys.stdin.buffer.read()
    frames = encode_wav_to_frames(wav_data)
    out = sys.stdout.buffer
    for f in frames:
        out.write(struct.pack("<H", len(f)))
        out.write(f)
    sys.stderr.write(f"[opus_encode_helper] {len(frames)} frames @{SAMPLE_RATE}Hz, "
                     f"TOC 1er=0x{frames[0][0]:02x} config={(frames[0][0]>>3)&0x1F} "
                     f"framecode={frames[0][0]&0x7}\n")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
