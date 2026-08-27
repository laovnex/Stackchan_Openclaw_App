# 🎙️ Audio del StackChan — Venv dedicado (opuslib_next) — 27/08/2026

## Qué es esto

El ai-server del StackChan convierte el WAV del TTS en **frames Opus** para que el
altavoz del robot los reproduzca. Esa codificación la hace `opus_encode_helper.py`
usando la librería **opuslib_next** (libopus moderno), que genera paquetes CELT 24k
con 4 subframes (TOC 0xdb / framecode 3) que el decodificador ESP32 reproduce limpio.

> ⚠️ La librería vieja (opusscript, WASM) producía 1 frame por paquete (TOC 0x58)
> y el firmware generaba **interferencias**. opuslib_next es EL FIX.

## ⚠️ IMPORTANTE: StackChan NO usa Kokoro

El TTS del robot es **Amazon Polly** (vía `tts_polly_bridge.py`, puerto 18002).
Kokoro es SOLO para los audios de Telegram de StackChan.

**Historia (por qué existe este venv):** el 25/08/2026 se metió opuslib_next dentro
de `venv_kokoro/` por comodidad, haciendo que el server dependiera del venv de TTS.
El 27/08/2026 el usuario ordenó sacarlo: **el env de kokoro es solo de kokoro**.

## El venv dedicado

| Dato | Valor |
|---|---|
| Ruta | `/opt/stackchan/.openclaw/workspace/venv_stackchan/` |
| Python | 3.14 (homebrew) |
| Paquete | `opuslib-next` 1.3.1 (instalado 27/08/2026) |
| Propietario | SOLO el ai-server del StackChan |

## Cómo se conecta el server al venv

El server (Node/tsx) llama al helper Python por `spawnSync`. La ruta del intérprete
se resuelve así:

1. **`.env`** → `STACKCHAN_OPUS_PYTHON_BIN=/opt/venv_stackchan/bin/python3`
2. **Fallback en código** (`src/audio.ts:22` y `dist/audio.js:63`): misma ruta hardcodeada.

**Si algún día se cambia la ruta, hay que tocar los 3 sitios** (`.env`, `src/audio.ts`,
`dist/audio.js`) y reiniciar el server:
`launchctl kickstart -k gui/$(id -u)/com.stackchan.ai-server`

## Verificación de funcionamiento

```bash
# Probar el helper directamente (WAV → frames Opus)
cat /tmp/test_opus.wav | /opt/venv_stackchan/bin/python3 \
  /opt/stackchan/hermes/ai-server/opus_encode_helper.py
# Esperado: "17 frames @24000Hz, TOC 1er=0x6b config=13 framecode=3"
```

- Mismo WAV con venv_kokoro y venv_stackchan → **mismo TOC (0x6b)** (verificado 27/08).
- Server reiniciado y verificado: escucha en `ws://0.0.0.0:8765/ws`, media en `:8765/media/`.
- `venv_kokoro` quedó **limpio de opus** (desinstalado opuslib + opuslib_next) y el TTS
  de Telegram (Kokoro em_alex) verificado funcionando tras la limpieza.

## Backups del cambio (27/08 08:55)

- `.env.bak-venvstackchan-20260827-0855`
- `src/audio.ts.bak-venvstackchan-20260827-0855`
- `dist/audio.js.bak-venvstackchan-20260827-0855`
- `opus_encode_helper.py.bak-venvstackchan-20260827-0855`

## Recrear el venv si se pierde

```bash
python3 -m venv /opt/venv_stackchan
/opt/venv_stackchan/bin/pip install opuslib_next
launchctl kickstart -k gui/$(id -u)/com.stackchan.ai-server
```
