# StackChan + OpenClaw — Robot de escritorio con voz

**StackChan_Openclaw_App** es un proyecto completo para convertir un robot de escritorio **StackChan** (M5Stack CoreS3) en un asistente de voz inteligente con cerebro **OpenClaw**.

El robot graba tu voz, la envía por WebSocket a tu servidor, y el servidor hace todo el trabajo: transcribe (whisper.cpp), piensa (OpenClaw) y habla de vuelta con una voz neural en español (Amazon Polly es-ES). El ESP32 es solo un terminal de audio con cara: la inteligencia vive en tu máquina.

> **¿Qué incluye este repo?** Las dos mitades del proyecto: el **servidor de voz** (`hermes/`) y el **firmware del robot** (`firmware/`).

---

## Lo que hace

- **Voz natural en español** — Amazon Polly neural (es-ES), en streaming
- **Cerebro OpenClaw** — conversación real, sesión estable por dispositivo
- **Selector de agentes en pantalla** — elige quién te atiende desde el propio robot
- **Avatar animado** — cara, ojos y lip-sync en el display del CoreS3
- **Audio pulido** — soft-clip y de-esser para que la voz suene limpia
- **Wake word** — activación por voz sin tocar nada

---

## Arquitectura

```
┌─────────────────────────┐ ┌──────────────────────────────────────┐
│ StackChan (ESP32-S3) │ │ Tu servidor (Mac / Linux / PC) │
│ ┌───────────────────┐ │ WS │ ┌────────────────────────────────┐ │
│ │ Cara + lip-sync │ │◄──────►│ │ hermes/ai-server (Node/tsx) │ │
│ │ Wake word │ │ :8765 │ │ WebSocket + VAD + emociones │ │
│ │ Micrófono │ │ │ └──┬───────────┬───────────┬─────┘ │
│ └───────────────────┘ │ │ │ │ │ │
│ App OpenClaw: │ │ ┌──▼───┐ ┌────▼────┐ ┌──▼──────┐ │
│ selector de agentes │ │ │ STT │ │ LLM │ │ TTS │ │
└─────────────────────────┘ │ │whisper│ │OpenClaw │ │ Polly │ │
 │ │ :10302│ │ │ │ :18002 │ │
 │ └──────┘ └─────────┘ └─────────┘ │
 └──────────────────────────────────────┘
```

- **STT** — whisper.cpp con modelo `ggml-large-v3-turbo`, idioma español
- **LLM** — OpenClaw, streaming por tramos, sesión persistente por dispositivo
- **TTS** — `tts_ha_bridge.py` llama a Amazon Polly directo (AWS REST SigV4), voz neural es-ES, salida ogg_vorbis 24 kHz
- **Audio** — cadena de procesado: PCM → soft-clip → de-esser → WAV → Opus

---

## Contenido

| Ruta | Qué es |
|---|---|
| `hermes/` | Servidor de voz completo (TypeScript + Python) |
| `hermes/ai-server/` | Servidor principal: WebSocket, TTS streaming, STT, VAD, emociones |
| `hermes/ai-server/src/` | Código fuente del servidor |
| `hermes/ai-server/tts_ha_bridge.py` | Puente TTS → Amazon Polly directo (REST SigV4), puerto 18002 |
| `hermes/ai-server/devices.json` | Enrutamiento de dispositivos → agente OpenClaw (ejemplo) |
| `hermes/config-editor/` | Editor web de configuración del firmware |
| `hermes/docs/` | Documentación y ADRs |
| `hermes/test-harness/` | Herramientas de prueba (e2e, WebSocket, binding) |
| `firmware/` | Firmware del robot (fork de xiaozhi-esp32 + app OpenClaw) |
| `firmware/main/` | Código propio: app OpenClaw, HAL, placa StackChan |
| `firmware/xiaozhi-esp32/` | Base del firmware (proyecto upstream) |

---

## Puesta en marcha

### Requisitos

- **Servidor**: macOS o Linux, Node.js 18+, Python 3.10+, ffmpeg
- **Firmware**: ESP-IDF (toolchain ESP32-S3), Python 3
- **Audio STT**: whisper.cpp compilado + modelo `ggml-large-v3-turbo.bin`
- **TTS**: credenciales de AWS (Polly, región `eu-west-1`)

### Paso 1 — Servidor

```bash
cd hermes/ai-server
npm install
cp .env.example .env # edita con tus credenciales
```

Configura al menos estas variables en `.env`:

```bash
STACKCHAN_AWS_AK=TU_CLAVE_AWS
STACKCHAN_AWS_SK=TU_SECRETO_AWS
STACKCHAN_LOCAL_TTS_URL=http://127.0.0.1:18002/
STACKCHAN_OPUS_PYTHON_BIN=/ruta/a/tu/venv/bin/python3
```

Arranca los tres servicios:

```bash
# 1. Transcripción (STT) — puerto 10302
whisper-server --model /ruta/ggml-large-v3-turbo.bin --host 0.0.0.0 --port 10302 --language es

# 2. Voz (TTS) — puerto 18002
python3 tts_ha_bridge.py

# 3. Servidor principal — puerto 8765
npx tsx src/index.ts
```

Verificación rápida:

```bash
lsof -iTCP:8765 -n -P | grep LISTEN # ai-server
lsof -iTCP:18002 -n -P | grep LISTEN # tts bridge
lsof -iTCP:10302 -n -P | grep LISTEN # whisper
curl -s -X POST http://127.0.0.1:18002/ -d "Hola" -o /tmp/test.wav
```

### Paso 2 — Firmware

```bash
cd firmware
python3 ./fetch_repos.py # descarga dependencias (mooncake, etc.)
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/tty.usbmodem* flash
```

Antes de flashear, configura tus valores en:

- `firmware/main/apps/app_openclaw/app_openclaw.cpp` → `kGatewayUrl` con la IP de tu servidor (`ws://<tu-ip>:8765/`) y los tokens de agente que definas
- `firmware/sdkconfig` → `CONFIG_OTA_URL` (no toques; ver nota de OTA abajo)
- `firmware/main/hal/board/` → ajustes de tu placa

> **IMPORTANTE — OTA desactivado**: este firmware es un fork con la app OpenClaw añadida. El OTA del proyecto original (xiaozhi-esp32) está **desactivado a propósito** (`CONFIG_OTA_URL` apunta a un sitio muerto en `sdkconfig.defaults`): si lo reactivas, el OTA original sobrescribiría el firmware y **perderías la app OpenClaw y el soporte de placa StackChan**. Las actualizaciones se hacen flasheando por USB (`idf.py flash`), no por OTA.

> **Mapeo de agentes**: el firmware manda un token por agente; el servidor lo traduce a sesión de OpenClaw en `hermes/ai-server/src/device_config.ts` (`AGENT_TOKEN_MAP`). Pon los mismos tokens en ambos sitios.

### Paso 3 — Conectar

1. Flashea el firmware y enciende el robot
2. El robot se conecta por WiFi a tu servidor (configura SSID/password en el setup del firmware)
3. En la pantalla del robot elige un agente
4. Habla. El robot te escucha, piensa y responde con voz

---

## Variables de entorno (servidor)

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto WebSocket | `8765` |
| `STACKCHAN_WS_KEEPALIVE_MS` | Intervalo de ping al robot (baja a 1000 si hay pausas) | `3000` |
| `STACKCHAN_LOCAL_TTS_URL` | URL del puente TTS | `http://127.0.0.1:18002/` |
| `HERMES_STT_URL` | URL de whisper | `http://127.0.0.1:10302` |
| `STACKCHAN_AWS_AK` / `STACKCHAN_AWS_SK` | Credenciales AWS Polly | — |
| `STACKCHAN_HA_TOKEN` | Token Home Assistant (solo fallback) | — |
| `STACKCHAN_TTS_SOFTCLIP_KNEE` | Umbral soft-clip (0 = off) | `29000` |
| `STACKCHAN_TTS_DEESSER_THRESHOLD` | Umbral de-esser (0 = off) | `7000` |
| `STACKCHAN_TTS_DEESSER_AMOUNT` | Fuerza de-esser | `0.5` |
| `STACKCHAN_OPUS_PYTHON_BIN` | Python del venv con `opuslib_next` | — |

---

## Solución de problemas

| Síntoma | Solución |
|---|---|
| El robot no conecta | Revisa `kGatewayUrl` del firmware y que el servidor escuche en `:8765` |
| Pausas aleatorias de silencio | Pon `STACKCHAN_WS_KEEPALIVE_MS=1000` |
| Voz con siseos / petardeos | Ajusta `STACKCHAN_TTS_DEESSER_*` (7000/0.5 por defecto) |
| Audio distorsionado en picos | Baja `STACKCHAN_TTS_SOFTCLIP_KNEE` o la ganancia |
| El wake word no responde | Vuelve a grabar el wake word con `tools/wake_word_flasher.py` |

---

## Créditos y licencias

Este proyecto se apoya en trabajo ajeno con licencia MIT. **Obligatorio mantener los avisos de copyright** (ver `LICENSE-M5STACK.md` y `LICENSE-XIAOZHI.md`).

| Proyecto | Uso | Licencia |
|---|---|---|
| [m5stack/AiStackChan](https://github.com/m5stack/AiStackChan) | Base del firmware del cuerpo: cara, servos, lip-sync, configuración | MIT (2026 M5Stack) |
| [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | Base del asistente de voz: audio, wake word, WebSocket, OTA | MIT (2025 Shenzhen Xinzhi) |
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | Referencia del patrón de conexión OpenClaw | MIT |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Referencia de hardware (pines, servos, cámara) | — |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Referencia del servidor (estado LED, Opus) | — |

El servidor (`hermes/`) es código propio inspirado en la arquitectura de plaipin. El firmware es un fork de xiaozhi-esp32 con la app OpenClaw y el soporte de placa StackChan añadidos.

---

## Notas de seguridad

- Este repo está **saneado**: no contiene credenciales reales ni datos personales
- Las credenciales reales viven en `.env` (ignorado por git). **Nunca** subas tu `.env` a un repo público
- Si haces un fork, revisa también tus propios secretos antes de publicar

---

## Licencia

MIT — ver `LICENSE-M5STACK.md` y `LICENSE-XIAOZHI.md` para los avisos de copyright de las bases. El código propio de este repo se distribuye bajo MIT, manteniendo los avisos de las licencias originales.

---

# StackChan + OpenClaw — Voice Desktop Robot

**Stackchan_Openclaw_App** is a complete project to turn a **StackChan** desktop robot (M5Stack CoreS3) into a smart voice assistant powered by **OpenClaw**.

The robot records your voice, streams it over WebSocket to your server, and the server does all the heavy lifting: speech-to-text (whisper.cpp), thinking (OpenClaw), and text-to-speech with a natural Spanish neural voice (Amazon Polly es-ES). The ESP32 is just an audio terminal with a face — the intelligence lives on your machine.

> **What's in this repo?** Both halves of the project: the **voice server** (`hermes/`) and the **robot firmware** (`firmware/`).

---

## Features

- **Natural Spanish voice** — Amazon Polly neural (es-ES), streaming
- **OpenClaw brain** — real conversation, stable session per device
- **On-screen agent selector** — pick who answers you right from the robot
- **Animated avatar** — face, eyes and lip-sync on the CoreS3 display
- **Polished audio** — soft-clip and de-esser for clean voice output
- **Wake word** — hands-free activation

---

## Architecture

```
┌─────────────────────────┐ ┌──────────────────────────────────────┐
│ StackChan (ESP32-S3) │ │ Your server (Mac / Linux / PC) │
│ ┌───────────────────┐ │ WS │ ┌────────────────────────────────┐ │
│ │ Face + lip-sync │ │◄──────►│ │ hermes/ai-server (Node/tsx) │ │
│ │ Wake word │ │ :8765 │ │ WebSocket + VAD + emotions │ │
│ │ Microphone │ │ │ └──┬───────────┬───────────┬─────┘ │
│ └───────────────────┘ │ │ │ │ │ │
│ OpenClaw app: │ │ ┌──▼───┐ ┌────▼────┐ ┌──▼──────┐ │
│ agent selector │ │ │ STT │ │ LLM │ │ TTS │ │
└─────────────────────────┘ │ │whisper│ │OpenClaw │ │ Polly │ │
 │ │ :10302│ │ │ │ :18002 │ │
 │ └──────┘ └─────────┘ └─────────┘ │
 └──────────────────────────────────────┘
```

- **STT** — whisper.cpp with `ggml-large-v3-turbo`, Spanish language
- **LLM** — OpenClaw, chunked streaming, persistent session per device
- **TTS** — `tts_ha_bridge.py` calls Amazon Polly directly (AWS REST SigV4), es-ES neural voice, ogg_vorbis 24 kHz output
- **Audio** — processing chain: PCM → soft-clip → de-esser → WAV → Opus

---

## Repository layout

| Path | What it is |
|---|---|
| `hermes/` | Complete voice server (TypeScript + Python) |
| `hermes/ai-server/` | Main server: WebSocket, TTS streaming, STT, VAD, emotions |
| `hermes/ai-server/src/` | Server source code |
| `hermes/ai-server/tts_ha_bridge.py` | TTS bridge → Amazon Polly direct (REST SigV4), port 18002 |
| `hermes/ai-server/devices.json` | Device → OpenClaw agent routing (example) |
| `hermes/config-editor/` | Web-based firmware config editor |
| `hermes/docs/` | Documentation and ADRs |
| `hermes/test-harness/` | Test tools (e2e, WebSocket, binding) |
| `firmware/` | Robot firmware (xiaozhi-esp32 fork + OpenClaw app) |
| `firmware/main/` | Own code: OpenClaw app, HAL, StackChan board |
| `firmware/xiaozhi-esp32/` | Firmware base (upstream project) |

---

## Getting started

### Prerequisites

- **Server**: macOS or Linux, Node.js 18+, Python 3.10+, ffmpeg
- **Firmware**: ESP-IDF (ESP32-S3 toolchain), Python 3
- **STT**: compiled whisper.cpp + `ggml-large-v3-turbo.bin` model
- **TTS**: AWS credentials (Polly, region `eu-west-1`)

### Step 1 — Server

```bash
cd hermes/ai-server
npm install
cp .env.example .env # edit with your credentials
```

At minimum, set these in `.env`:

```bash
STACKCHAN_AWS_AK=YOUR_AWS_KEY
STACKCHAN_AWS_SK=YOUR_AWS_SECRET
STACKCHAN_LOCAL_TTS_URL=http://127.0.0.1:18002/
STACKCHAN_OPUS_PYTHON_BIN=/path/to/your/venv/bin/python3
```

Start the three services:

```bash
# 1. Speech-to-text (STT) — port 10302
whisper-server --model /path/ggml-large-v3-turbo.bin --host 0.0.0.0 --port 10302 --language es

# 2. Text-to-speech (TTS) — port 18002
python3 tts_ha_bridge.py

# 3. Main server — port 8765
npx tsx src/index.ts
```

Quick verification:

```bash
lsof -iTCP:8765 -n -P | grep LISTEN # ai-server
lsof -iTCP:18002 -n -P | grep LISTEN # tts bridge
lsof -iTCP:10302 -n -P | grep LISTEN # whisper
curl -s -X POST http://127.0.0.1:18002/ -d "Hello" -o /tmp/test.wav
```

### Step 2 — Firmware

```bash
cd firmware
python3 ./fetch_repos.py # fetch dependencies (mooncake, etc.)
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/tty.usbmodem* flash
```

Before flashing, configure your values in:

- `firmware/main/apps/app_openclaw/app_openclaw.cpp` → `kGatewayUrl` with your server IP (`ws://<your-ip>:8765/`) and the agent tokens you define
- `firmware/sdkconfig` → `CONFIG_OTA_URL` (do not touch; see OTA note below)
- `firmware/main/hal/board/` → your board settings

> **IMPORTANT — OTA disabled**: this firmware is a fork with the OpenClaw app added. The OTA of the original project (xiaozhi-esp32) is **intentionally disabled** (`CONFIG_OTA_URL` points to a dead site in `sdkconfig.defaults`): if you re-enable it, the original OTA would overwrite the firmware and **you would lose the OpenClaw app and the StackChan board support**. Updates are done by flashing over USB (`idf.py flash`), not via OTA.

> **Agent mapping**: the firmware sends one token per agent; the server maps it to an OpenClaw session in `hermes/ai-server/src/device_config.ts` (`AGENT_TOKEN_MAP`). Use the same tokens on both sides.

### Step 3 — Connect

1. Flash the firmware and power the robot on
2. The robot joins your Wi-Fi and connects to your server (set SSID/password in firmware setup)
3. Pick an agent on the robot screen
4. Talk. The robot listens, thinks and answers with voice

---

## Environment variables (server)

| Variable | Description | Default |
|---|---|---|
| `PORT` | WebSocket port | `8765` |
| `STACKCHAN_WS_KEEPALIVE_MS` | Robot ping interval (lower to 1000 if you see pauses) | `3000` |
| `STACKCHAN_LOCAL_TTS_URL` | TTS bridge URL | `http://127.0.0.1:18002/` |
| `HERMES_STT_URL` | whisper URL | `http://127.0.0.1:10302` |
| `STACKCHAN_AWS_AK` / `STACKCHAN_AWS_SK` | AWS Polly credentials | — |
| `STACKCHAN_HA_TOKEN` | Home Assistant token (fallback only) | — |
| `STACKCHAN_TTS_SOFTCLIP_KNEE` | Soft-clip threshold (0 = off) | `29000` |
| `STACKCHAN_TTS_DEESSER_THRESHOLD` | De-esser threshold (0 = off) | `7000` |
| `STACKCHAN_TTS_DEESSER_AMOUNT` | De-esser strength | `0.5` |
| `STACKCHAN_OPUS_PYTHON_BIN` | Python of the venv with `opuslib_next` | — |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Robot does not connect | Check `kGatewayUrl` in firmware and that the server listens on `:8765` |
| Random silence pauses | Set `STACKCHAN_WS_KEEPALIVE_MS=1000` |
| Sibilant / crackling voice | Tune `STACKCHAN_TTS_DEESSER_*` (default 7000/0.5) |
| Distorted audio on peaks | Lower `STACKCHAN_TTS_SOFTCLIP_KNEE` or the gain |
| Wake word not responding | Re-record the wake word with `tools/wake_word_flasher.py` |

---

## Credits and licenses

This project builds on third-party work under the MIT license. **You must keep the copyright notices** (see `LICENSE-M5STACK.md` and `LICENSE-XIAOZHI.md`).

| Project | Used for | License |
|---|---|---|
| [m5stack/AiStackChan](https://github.com/m5stack/AiStackChan) | Firmware body base: face, servos, lip-sync, config | MIT (2026 M5Stack) |
| [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | Voice assistant base: audio, wake word, WebSocket, OTA | MIT (2025 Shenzhen Xinzhi) |
| [PlaiPin/plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) | OpenClaw connection pattern reference | MIT |
| [migratorywhale/stackchan-mcp](https://github.com/migratorywhale/stackchan-mcp) | Hardware reference (pins, servos, camera) | — |
| [waynecc-at/robot-bridge](https://github.com/waynecc-at/robot-bridge) | Server reference (LED state, Opus) | — |

The server (`hermes/`) is original code inspired by plaipin's architecture. The firmware is a fork of xiaozhi-esp32 with the OpenClaw app and StackChan board support added.

---

## Security notes

- This repo is **sanitized**: no real credentials or personal data
- Real credentials live in `.env` (git-ignored). **Never** commit your `.env` to a public repo
- If you fork this, review your own secrets before publishing

---

## License

MIT — see `LICENSE-M5STACK.md` and `LICENSE-XIAOZHI.md` for the base copyright notices. The original code in this repo is distributed under MIT, keeping the original license notices.
