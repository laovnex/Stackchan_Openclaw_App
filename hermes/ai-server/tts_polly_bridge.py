#!/usr/bin/env python3
"""
TTS Bridge — StackChan → Amazon Polly DIRECTO (AWS REST SigV4)
POST texto plano -> WAV 24kHz mono (ogg_vorbis 24k nativo de Polly).

v10 (StackChan 25/08 18:2x): Polly directo con credenciales del YAML de HA
(la config de HA está en /etc/homeassistant/configuration.yaml).
- ogg_vorbis@24000 = máxima calidad nativa (el mp3 de HA era 22k/48kbps)
- Fallback a HA (tts_get_url) si la llamada directa falla.
Usa urllib + ffmpeg.
"""
import datetime
import hashlib
import hmac
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_env_file():
    """Carga el .env del directorio del script (si existe) para credenciales."""
    try:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        with open(env_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


load_env_file()

# --- Credenciales AWS Polly (leídas del .env, nunca en el código) ---
AWS_AK = os.environ.get("STACKCHAN_AWS_AK", "")
AWS_SK = os.environ.get("STACKCHAN_AWS_SK", "")
REGION = "eu-west-1"
SERVICE = "polly"
VOICE = "Sergio"
ENGINE = "neural"
PORT = 18002

# --- Fallback HA ---
HA_URL = "http://homeassistant.local:8123"
HA_TOKEN = os.environ.get("STACKCHAN_HA_TOKEN", "")

FFMPEG_FILTER = "volume=5.0,alimiter=limit=0.98"


def log(msg):
    print(f"[tts-bridge] {msg}", flush=True)


# ---------- AWS SigV4 ----------
def _sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sig_key(secret, date_stamp, region, service):
    k_date = _sign(("AWS4" + secret).encode("utf-8"), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    return _sign(k_service, "aws4_request")


def polly_direct(text):
    """Sintetiza con Polly directo. Devuelve bytes del audio (ogg_vorbis 24k)."""
    host = f"polly.{REGION}.amazonaws.com"
    endpoint = f"https://{host}/v1/speech"
    body = json.dumps({
        "Engine": ENGINE,
        "LanguageCode": "es-ES",
        "OutputFormat": "ogg_vorbis",
        "SampleRate": "24000",
        "Text": text,
        "TextType": "text",
        "VoiceId": VOICE,
    }).encode("utf-8")
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "Host": host,
        "X-Amz-Date": amz_date,
    }
    canonical_headers = "".join(f"{k.lower()}:{v.strip()}\n" for k, v in sorted(headers.items()))
    signed_headers = ";".join(sorted(k.lower() for k in headers))
    canonical_request = "\n".join([
        "POST", "/v1/speech", "", canonical_headers, signed_headers, payload_hash,
    ])
    scope = f"{date_stamp}/{REGION}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    sig = hmac.new(_sig_key(AWS_SK, date_stamp, REGION, SERVICE),
                   string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    auth = (f"AWS4-HMAC-SHA256 Credential={AWS_AK}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={sig}")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Amz-Date", amz_date)
    req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


# ---------- Fallback HA ----------
def ha_request(path, data=None, timeout=25):
    url = f"{HA_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def polly_via_ha(text):
    raw = ha_request("/api/tts_get_url", {
        "engine_id": "amazon_polly", "message": text, "options": {},
    })
    url = json.loads(raw).get("url")
    if not url:
        raise RuntimeError("tts_get_url sin url")
    if url.startswith("http"):
        mp3_url = url
    else:
        mp3_url = HA_URL + url
    req = urllib.request.Request(mp3_url, headers={"Authorization": f"Bearer {HA_TOKEN}"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read()


# ---------- Synth ----------
def synth(text):
    audio = None
    source = "direct"
    try:
        audio = polly_direct(text)
    except Exception as e:
        log(f"polly_direct fallo ({e}); fallback a HA")
        source = "ha"
        audio = polly_via_ha(text)
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", "pipe:0",
         "-filter:a", FFMPEG_FILTER,
         "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-f", "wav", "pipe:1"],
        input=audio, capture_output=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg: {proc.stderr.decode(errors='replace')[:200]}")
    log(f"OK [{source}] '{text[:50]}' -> {len(proc.stdout)}B")
    return proc.stdout


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        text = self.rfile.read(length).decode("utf-8", errors="replace").strip()
        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"empty")
            return
        try:
            wav = synth(text)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:
            log(f"ERROR: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode(errors="replace")[:200])

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"Puente TTS (Polly directo) en http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
