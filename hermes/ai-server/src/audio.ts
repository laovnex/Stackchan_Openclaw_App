// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpusScript = require('opusscript') as typeof import('opusscript')
import { spawnSync, SpawnSyncReturns } from 'child_process'
import * as path from 'path'

export const INPUT_SAMPLE_RATE = 16000
export const INPUT_FRAME_DURATION_MS = 60
export const INPUT_FRAME_SAMPLES = (INPUT_SAMPLE_RATE * INPUT_FRAME_DURATION_MS) / 1000  // 960

// StackChan 25/08 21:10: DESCUBRIMIENTO — LA CHINA RESPONDE 24000 EN SU HELLO
// (capturado con proxy: sample_rate:24000 aunque el firmware pida 16000) y su
// encoder opuslib_next genera TOC=0xdb (CELT 24k con 4 subframes, framecode 3).
// opusscript (libopus viejo WASM) genera TOC=0x58 (1 frame por paquete) → el
// decodificador del ESP32 produce INTERFERENCIA. FIX: codificar con opuslib_next.
export const OUTPUT_SAMPLE_RATE = 24000
export const OUTPUT_FRAME_DURATION_MS = 60
const OUTPUT_FRAME_SAMPLES = (OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_DURATION_MS) / 1000  // 1440
const OUTPUT_GAIN = readOutputGain()
const OUTPUT_PCM_INPUT_MODE = readOpusPcmInputMode()

// Python con opuslib_next (misma librería que el servidor xiaozhi de la china)
const OPUS_PYTHON_BIN = process.env.STACKCHAN_OPUS_PYTHON_BIN ?? '/opt/venv_stackchan/bin/python3'
const OPUS_HELPER = path.join(__dirname, '..', 'opus_encode_helper.py')

const inputDecoder = new OpusScript(INPUT_SAMPLE_RATE, 1)

export type InputOpusDecoder = {
    decodeFrame(opus: Buffer): Buffer
    dispose(): void
}

export function createInputOpusDecoder(): InputOpusDecoder {
    const decoder = new OpusScript(INPUT_SAMPLE_RATE, 1) as OpusDecoderInternals
    return {
        decodeFrame(opus: Buffer): Buffer {
            const pcm = decoder.decode(opus)
            return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        },
        dispose(): void {
            // StackChan fix v10.4: opusscript crashea con "memory access out of bounds"
            // al destruir el decoder en Node 26 (bug de destroy_handler). try/catch
            // para que el proceso NUNCA muera por esto.
            try {
                decoder.delete?.()
            } catch {
                /* opusscript wasm dispose crash - ignorado a proposito */
            }
        },
    }
}

// BinaryProtocol3: [type:1][reserved:1][payload_size:2 BE][payload...]
// Xiaozhi v3 uses type 0 for Opus. Type 1 is accepted for compatibility with older local builds.
// BinaryProtocol2: [version:2][type:2][reserved:4][timestamp:4][payload_size:4 BE][payload...]
// version 1 (or other): raw Opus bytes

export function extractOpusPayload(data: Buffer, version: number): Buffer | null {
    if (version === 3) {
        if (data.length < 4) return null
        if (data[0] !== 0x00 && data[0] !== 0x01) return null  // type != Opus
        const size = data.readUInt16BE(2)
        if (size <= 0 || 4 + size > data.length) return null
        return Buffer.from(data.subarray(4, 4 + size))
    }
    if (version === 2) {
        if (data.length < 16) return null
        // type field (offset 2, uint16): 0 = OPUS
        const type = data.readUInt16BE(2)
        if (type !== 0) return null
        const size = data.readUInt32BE(12)
        if (size <= 0 || 16 + size > data.length) return null
        return Buffer.from(data.subarray(16, 16 + size))
    }
    if (data.length === 0) return null
    return data  // raw
}

export function wrapOpusPayload(opus: Buffer, version: number): Buffer {
    if (version === 3) {
        const header = Buffer.alloc(4)
        header[0] = 0x00
        header[1] = 0x00
        header.writeUInt16BE(opus.length, 2)
        return Buffer.concat([header, opus])
    }
    if (version === 2) {
        const header = Buffer.alloc(16)
        header.writeUInt16BE(2, 0)      // version
        header.writeUInt16BE(0, 2)      // type = OPUS
        header.writeUInt32BE(0, 4)      // reserved
        header.writeUInt32BE(0, 8)      // timestamp
        header.writeUInt32BE(opus.length, 12)
        return Buffer.concat([header, opus])
    }
    return opus
}

export function decodeOpusFrames(frames: Buffer[]): Buffer {
    const chunks: Buffer[] = []
    for (const frame of frames) {
        try {
            const pcm = inputDecoder.decode(frame)
            chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
        } catch {
            // 壊れたフレームはスキップ
        }
    }
    return Buffer.concat(chunks)
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)   // mono
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
}

export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number } {
    const sampleRate = wav.readUInt32LE(24)
    const dataIdx = wav.indexOf(Buffer.from('data'))
    if (dataIdx === -1) throw new Error('WAV data chunk not found')
    return { pcm: wav.subarray(dataIdx + 8), sampleRate }
}

function resamplePcm(pcm: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return pcm
    const inputSamples = pcm.length / 2
    const outputSamples = Math.ceil(inputSamples * toRate / fromRate)
    const out = Buffer.alloc(outputSamples * 2)
    for (let i = 0; i < outputSamples; i++) {
        const src = i * fromRate / toRate
        const idx = Math.floor(src)
        const frac = src - idx
        const s0 = idx < inputSamples ? pcm.readInt16LE(idx * 2) : 0
        const s1 = idx + 1 < inputSamples ? pcm.readInt16LE((idx + 1) * 2) : s0
        const v = Math.round(s0 + frac * (s1 - s0))
        out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2)
    }
    return out
}

function readOutputGain(): number {
    const gain = Number(process.env.STACKCHAN_TTS_OUTPUT_GAIN ?? 0.65)
    if (!Number.isFinite(gain)) return 0.65
    return Math.max(0.1, Math.min(5.0, gain))
}

// ---- Limitador suave anti petardeo (27/08/2026) ----
// Comprime SOLO los picos que pasan del knee en vez de cortarlos en seco.
// El volumen percibido se mantiene: la voz normal va por debajo del umbral.
// 0 = desactivado. Factor 0.3 = compresion suave por encima del knee.
function readSoftClipKnee(): number {
    const knee = Number(process.env.STACKCHAN_TTS_SOFTCLIP_KNEE ?? 29000)
    if (!Number.isFinite(knee)) return 29000
    return Math.max(0, Math.min(32767, knee))
}

const SOFTCLIP_KNEE = readSoftClipKnee()
const SOFTCLIP_FACTOR = 0.3

function applySoftClip(pcm: Buffer): Buffer {
    if (SOFTCLIP_KNEE <= 0 || SOFTCLIP_KNEE >= 32767) return pcm
    const out = Buffer.alloc(pcm.length)
    const knee = SOFTCLIP_KNEE
    for (let i = 0; i + 1 < pcm.length; i += 2) {
        const s = pcm.readInt16LE(i)
        let v = s
        if (s > knee) {
            v = Math.round(knee + (s - knee) * SOFTCLIP_FACTOR)
        } else if (s < -knee) {
            v = Math.round(-knee - (s + knee) * SOFTCLIP_FACTOR)
        }
        out.writeInt16LE(v, i)
    }
    return out
}

// ---- De-esser anti siseo (27/08/2026) ----
// Atenúa solo la banda de las eses (agudos) cuando aparecen picos de siseo,
// dejando el resto del audio intacto. Es quirúrgico: no baja el volumen general.
// Umbral 0 = desactivado.
function readDeEsserThreshold(): number {
    const v = Number(process.env.STACKCHAN_TTS_DEESSER_THRESHOLD ?? 0)
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(32767, v))
}

const DEESSER_THRESHOLD = readDeEsserThreshold()
const DEESSER_AMOUNT = Math.max(0, Math.min(1, Number(process.env.STACKCHAN_TTS_DEESSER_AMOUNT ?? 0.5) || 0.5))

function applyDeEsser(pcm: Buffer): Buffer {
    if (DEESSER_THRESHOLD <= 0) return pcm
    const n = Math.floor(pcm.length / 2)
    const out = Buffer.alloc(pcm.length)
    let prev = 0
    let env = 0
    const release = 0.8
    const th = DEESSER_THRESHOLD
    for (let i = 0; i < n; i++) {
        const x = pcm.readInt16LE(i * 2)
        // Banda de siseo aproximada: diferencia entre muestras (enfatiza agudos)
        const hi = x - prev
        prev = x
        // Envolvente con release lento
        env = Math.max(Math.abs(hi), env * release)
        let g = 1
        if (env > th) {
            const excess = Math.min(1, (env - th) / th)
            g = 1 - DEESSER_AMOUNT * excess
        }
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * g))), i * 2)
    }
    return out
}

type OpusPcmInputMode = 'direct' | 'buffer' | 'int16'

function readOpusPcmInputMode(): OpusPcmInputMode {
    const mode = process.env.STACKCHAN_OPUS_PCM_INPUT?.trim().toLowerCase()
    if (mode === 'int16') return mode
    return 'buffer'
}

type OpusEncoderInternals = {
    encode(buffer: Buffer, frameSize: number): Buffer
    handler?: {
        _encode(inputPointer: number, inputLength: number, outputPointer: number, frameSize: number): number
    }
    inPCM?: Uint16Array
    inPCMPointer?: number
    outOpusPointer?: number
    delete?: () => void
}

type OpusDecoderInternals = {
    decode(buffer: Buffer): Buffer
    delete?: () => void
}

function encodePcmFrame(outputEncoder: OpusEncoderInternals, chunk: Buffer): Buffer {
    if (OUTPUT_PCM_INPUT_MODE === 'int16') {
        return outputEncoder.encode(pcmChunkToInt16Array(chunk), OUTPUT_FRAME_SAMPLES)
    }

    // OpusScript's public encode() builds HEAPU16.subarray() with a byte pointer
    // as the element index. Once the shared WASM heap grows, that view can become
    // length 0 and TTS frames fail with "offset is out of bounds". Keep the same
    // PCM representation the wrapper expects, but create the view from a byte
    // offset so output TTS stays stable after long input-decoder activity.
    const heapBuffer = outputEncoder.inPCM?.buffer
    const inputPointer = outputEncoder.inPCMPointer
    const outputPointer = outputEncoder.outOpusPointer
    const handler = outputEncoder.handler
    if (
        heapBuffer
        && typeof inputPointer === 'number'
        && typeof outputPointer === 'number'
        && Number.isInteger(inputPointer)
        && Number.isInteger(outputPointer)
        && handler
    ) {
        const pcmWords = new Uint16Array(heapBuffer, inputPointer, chunk.length)
        pcmWords.set(chunk)
        const encodedLength = handler._encode(inputPointer, chunk.length, outputPointer, OUTPUT_FRAME_SAMPLES)
        if (encodedLength < 0) throw new Error(`Encode error: ${encodedLength}`)
        return Buffer.from(new Uint8Array(heapBuffer, outputPointer, encodedLength))
    }

    return outputEncoder.encode(chunk, OUTPUT_FRAME_SAMPLES)
}

function applyPcmGain(pcm: Buffer, gain: number): Buffer {
    if (gain >= 0.999) return pcm
    const out = Buffer.alloc(pcm.length)
    for (let i = 0; i + 1 < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i)
        const scaled = Math.round(sample * gain)
        out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i)
    }
    return out
}

export function encodeWavToOpusFrames(wav: Buffer, leadSilenceMs = 0): Buffer[] {
    const { pcm, sampleRate } = wavToPcm(wav)
    // Ganancia + silencio inicial sobre el PCM original (el helper resamplea a 24k
    // con ffmpeg, calidad alta — nada de interpolación lineal del TS)
    let processed = applyPcmGain(pcm, OUTPUT_GAIN)
    processed = applySoftClip(processed)
    processed = applyDeEsser(processed)
    if (leadSilenceMs > 0) {
        const leadSamples = Math.ceil((leadSilenceMs / 1000) * sampleRate)
        processed = Buffer.concat([Buffer.alloc(leadSamples * 2, 0), processed])
    }
    const wavForEncode = pcmToWav(processed, sampleRate)
    return encodeWithOpuslibNext(wavForEncode)
}

/**
 * StackChan 25/08 21:10: FIX DEFINITIVO de la interferencia.
 * Codifica el WAV con opuslib_next (libopus moderno) EXACTAMENTE como el
 * servidor xiaozhi de la china: 24000 Hz + APPLICATION_AUDIO + bitrate 24000 +
 * complexity 10 → paquetes CELT con 4 subframes (TOC 0xdb, framecode 3) que el
 * decodificador del ESP32 reproduce LIMPIO.
 * opusscript (libopus viejo WASM) generaba 1 frame por paquete (TOC 0x58) →
 * el firmware producía interferencia.
 */
function encodeWithOpuslibNext(wav: Buffer): Buffer[] {
    // StackChan 26/08 00:04 + 07:57: fix cortes intermitentes del helper python
    // (ETIMEDOUT, patrón: primer uso tras reposo/larga parada del Mac).
    // Estrategia: 1er intento con timeout corto (15s) para fallar rápido si
    // Python tarda en despertar; reintento con timeout largo (120s) que casi
    // siempre sale bien (el 2º spawn ya va más caliente).
    const runHelper = (timeoutMs: number): SpawnSyncReturns<Buffer> => {
        const result = spawnSync(OPUS_PYTHON_BIN, [OPUS_HELPER], {
            input: wav,
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
            timeout: timeoutMs,
        })
        return result
    }
    let result = runHelper(15_000)
    if (result.error || result.status !== 0) {
        console.warn(`[opus_encode_helper] intento 1 falló (${String(result.error ?? `rc=${result.status}`)}) — reintentando con más margen...`)
        result = runHelper(120_000)
    }
    if (result.error) throw new Error(`opus_encode_helper: ${String(result.error)}`)
    if (result.status !== 0) {
        const err = result.stderr?.toString() ?? 'sin stderr'
        throw new Error(`opus_encode_helper falló (rc=${result.status}): ${err.slice(0, 300)}`)
    }

    const frames: Buffer[] = []
    const data = result.stdout
    let off = 0
    while (off + 2 <= data.length) {
        const n = data.readUInt16LE(off)
        off += 2
        frames.push(data.subarray(off, off + n))
        off += n
    }
    return frames
}

// StackChan 26/08 07:57: pre-calentamiento del helper al arrancar. Carga Python
// + opuslib_next en caché para que los encodes de la conversación no sufran
// el arranque en frío (causa de los ETIMEDOUT tras reposo del Mac).
export function warmUpOpusHelper(): void {
    try {
        const silencePcm = Buffer.alloc(2400 * 2) // 100ms de silencio @24kHz s16
        const wav = pcmToWav(silencePcm, 24000)
        const frames = encodeWithOpuslibNext(wav)
        console.log(`[opus_encode_helper] warm-up OK (${frames.length} frames de prueba)`)
    } catch (e) {
        console.warn(`[opus_encode_helper] warm-up falló (no crítico): ${String(e)}`)
    }
}

function pcmChunkToInt16Array(chunk: Buffer): Buffer {
    const samples = new Int16Array(OUTPUT_FRAME_SAMPLES)
    for (let sample = 0; sample < OUTPUT_FRAME_SAMPLES; sample++) {
        samples[sample] = chunk.readInt16LE(sample * 2)
    }
    return samples as unknown as Buffer
}
