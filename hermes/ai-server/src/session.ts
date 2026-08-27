import { randomUUID } from 'crypto'
import type WebSocket from 'ws'
import { createInputOpusDecoder, decodeOpusFrames, encodeWavToOpusFrames, extractOpusPayload, pcmToWav, wrapOpusPayload, INPUT_SAMPLE_RATE, INPUT_FRAME_DURATION_MS, OUTPUT_SAMPLE_RATE, OUTPUT_FRAME_DURATION_MS, type InputOpusDecoder } from './audio.js'
import { HermesClient, type HermesPromptStreamEvent } from './hermes.js'
import { OpenClawClient } from './openclaw.js'
import type { DeviceBinding } from './device_config.js'
import { transcribeWithHermes, synthesizeWithHermes } from './hermes_audio.js'
import { registerDeviceSession, type StackChanBridgeStatus } from './device_control.js'
import { extractFirstDisplayImage, resolveDisplayImageSource, stripMediaForSpeech } from './media.js'
import { elapsedMs, nowMs, withTiming } from './timing.js'
import { LocalRmsVad, readLocalRmsVadConfig, rmsNormalized, type LocalRmsVadConfig } from './local_vad.js'
import {
    playWavOnLocalTarget,
    readLocalTtsOutputConfig,
    resolveLocalTtsOutputTarget,
    type LocalTtsOutputConfig,
} from './local_audio_output.js'

type State = 'idle' | 'listening' | 'processing'
export type StackChanEmotion = 'neutral' | 'happy' | 'laughing' | 'angry' | 'sad' | 'crying' | 'sleepy' | 'doubtful'

export type TurnControlConfig = {
    silenceTimeoutMs: number
    maxRecordingMs: number
    minFramesForStt: number
    postTtsCooldownMs: number
}

export type BargeInConfig = {
    enabled: boolean
    rmsThreshold: number
    startSpeechMs: number
    minSpeechMs: number
    ignoreTtsStartMs: number
}

export type SpeechSegmentationConfig = {
    maxSpeechChars: number
    segmentMaxChars: number
    maxSegments: number
}

export type AutoLedConfig = {
    enabled: boolean
    manualHoldMs: number
}

export function readEnvInt(
    name: string,
    fallback: number,
    min: number,
    max: number,
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
}

export function readEnvFloat(
    name: string,
    fallback: number,
    min: number,
    max: number,
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

export function readEnvBool(
    name: string,
    fallback: boolean,
    env: Record<string, string | undefined> = process.env,
): boolean {
    const raw = env[name]
    if (!raw) return fallback
    return /^(1|true|yes|on)$/i.test(raw.trim())
}

export function readTurnControlConfig(env: Record<string, string | undefined> = process.env): TurnControlConfig {
    return {
        silenceTimeoutMs: readEnvInt('STACKCHAN_SILENCE_TIMEOUT_MS', 1200, 300, 5000, env),
        maxRecordingMs: readEnvInt('STACKCHAN_MAX_RECORDING_MS', 15000, 3000, 60000, env),
        minFramesForStt: readEnvInt('STACKCHAN_MIN_FRAMES_FOR_STT', 10, 1, 100, env),
        postTtsCooldownMs: readEnvInt('STACKCHAN_POST_TTS_COOLDOWN_MS', 1500, 0, 10000, env),
    }
}

export function readBargeInConfig(env: Record<string, string | undefined> = process.env): BargeInConfig {
    return {
        enabled: readEnvBool('STACKCHAN_BARGE_IN_ENABLED', false, env),
        rmsThreshold: readEnvFloat('STACKCHAN_BARGE_IN_RMS_THRESHOLD', 0.03, 0.005, 1.0, env),
        startSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_START_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 2000, env),
        minSpeechMs: readEnvInt('STACKCHAN_BARGE_IN_MIN_SPEECH_MS', 180, INPUT_FRAME_DURATION_MS, 3000, env),
        ignoreTtsStartMs: readEnvInt('STACKCHAN_BARGE_IN_IGNORE_TTS_START_MS', 300, 0, 5000, env),
    }
}

export function readSpeechSegmentationConfig(env: Record<string, string | undefined> = process.env): SpeechSegmentationConfig {
    return {
        maxSpeechChars: readEnvInt('STACKCHAN_MAX_SPEECH_CHARS', 800, 8, 4000, env),
        segmentMaxChars: readEnvInt('STACKCHAN_TTS_SEGMENT_MAX_CHARS', 160, 8, 800, env),
        maxSegments: readEnvInt('STACKCHAN_TTS_MAX_SEGMENTS', 8, 1, 32, env),
    }
}

export function readAutoLedConfig(env: Record<string, string | undefined> = process.env): AutoLedConfig {
    return {
        enabled: readEnvBool('STACKCHAN_AUTO_LED_ENABLED', true, env),
        manualHoldMs: readEnvInt('STACKCHAN_AUTO_LED_MANUAL_HOLD_MS', 8000, 0, 60000, env),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DICCIONARIO DE EMOCIONES — SOLO ESPAÑOL, AMPLIADO A SACO (26/08 10:43)
// Orden del usuario: fuera inglés/japonés, español de la calle a lo grande.
// NOTA GITHUB: si esto se publica, re-añadir claves en inglés (ver backup
// session.ts.bak-diccionario-20260826-1041).
// Estructura: listas de palabras/expresiones por emoción. buildEmotionRe()
// construye un regex por emoción: EMOTION_RE (diccionario completo, para
// votos) y STRONG_EMOTION_RE (subconjunto de alta carga, cambio inmediato).
// ═══════════════════════════════════════════════════════════════════════════
const EMOTION_WORDS: Record<StackChanEmotion, string[]> = {
    laughing: [
        'jaja', 'jeje', 'jiji', 'jojo', 'jajaja', 'jajajaja', 'jajajajaja',
        'me parto', 'me parto de risa', 'me descojono', 'me descojono de risa',
        'me meo', 'me meo de risa', 'me troncho', 'me troncho de risa',
        'me cago de risa', 'me cago en la risa', 'me rio', 'me río',
        'me estoy riendo', 'risa', 'risas', 'de risa', 'qué risa', 'que risa',
        'qué gracia', 'que gracia', 'qué chiste', 'que chiste',
        'descojonante', 'tronchante', 'desternillante', 'divertidísimo',
        'divertidisimo', 'graciosísimo', 'graciosisimo', 'gracioso', 'graciosa',
        'es la hostia de gracioso', 'buenísimo', 'buenisimo',
        // Ampliación StackChan v2 (26/08 22:30):
        'qué bueno', 'que bueno', 'es la hostia', 'es la hostia de bueno',
        'me río yo', 'me rio yo', 'no puedo parar de reír', 'no puedo parar de reir',
        '😂', '🤣', '😆', '😹', '🤭', '😜', '🤪', '🙃',
    ],
    crying: [
        'llorar', 'lloro', 'llorando', 'llora', 'lloras', 'lloren',
        'lloriqueando', 'llorica', 'llorón', 'llorona', 'llorando a moco tendido',
        'echarme a llorar', 'echo a llorar', 'echó a llorar', 'a llorar',
        'me dan ganas de llorar', 'ganas de llorar', 'sollozar', 'sollozo',
        'lágrimas', 'lagrimas', 'llorera', 'qué llanto', 'que llanto',
        // Ampliación StackChan v2 (26/08 22:30):
        'me voy a poner a llorar', 'qué penita', 'que penita', 'lagrimita',
        'estoy llorando', 'no puedo parar de llorar',
        '😭', '😢', '😿',
    ],
    happy: [
        'feliz', 'felices', 'felicidad', 'alegre', 'alegres', 'alegría', 'alegria',
        'contento', 'contenta', 'contentos', 'contentísimo', 'contentisimo',
        'encantado', 'encantada', 'emocionado', 'emocionada', 'ilusionado', 'ilusionada',
        'genial', 'perfecto', 'excelente', 'estupendo', 'fantástico', 'fantastico',
        'espectacular', 'maravilloso', 'maravillosa', 'asombroso', 'increíble', 'increible',
        'brutal', 'bestial', 'alucinante', 'cojonudo', 'cojonuda', 'guay', 'chulo',
        'chula', 'molón', 'molona', 'mola', 'mola mazo', 'mola un montón',
        'me encanta', 'me encantan', 'me encantaría', 'me chifla', 'me flipa',
        'me alucina', 'me apasiona', 'me pone contento',
        'me alegra', 'me alegro', 'me alegra mucho', 'me alegro mucho',
        'qué alegría', 'que alegria', 'qué bien', 'que bien', 'qué guay', 'que guay',
        'qué chulo', 'que chulo', 'qué ilusión', 'que ilusion', 'qué suerte', 'que suerte',
        'suertudo', 'suertuda', 'qué bonito', 'que bonito', 'qué bonita', 'que bonita',
        'buena noticia', 'buenísimo', 'buenisimo', 'buenísima', 'buenisima',
        'qué pasada', 'que pasada', 'qué maravilla', 'que maravilla',
        'precioso', 'preciosa', 'guapísimo', 'guapisimo', 'guapísima', 'guapisima',
        'bravo', 'enhorabuena', 'felicidades', 'felicitaciones', 'olé', 'ole ole',
        'orgulloso', 'orgullosa', 'orgullo',
        'te quiero', 'te quiero mucho', 'te quiero un montón', 'te amo', 'te adoro',
        'os quiero', 'os quiero mucho',
        'gracias', 'gracias por', 'muchas gracias', 'mil gracias', 'muchísimas gracias',
        'estoy feliz', 'estoy contento', 'estoy contenta', 'me siento genial',
        'estoy de puta madre', 'de puta madre', 'la hostia de bien', 'la leche de bien',
        'qué bien me sienta', 'que bien me sienta', 'pedazo de',
        // Frases hechas de StackChan (26/08 10:50, añadidas por orden del usuario:
        // "añade tú las tuyas"): las que suelto constantemente en conversación.
        'como tú digas', 'como tu digas', 'tú marcas el ritmo', 'tu marcas el ritmo',
        'lo que tú digas', 'lo que tu digas', 'cuando quieras', 'me alegro de oír eso',
        'me alegro de oir eso', 'buena pregunta', 'tiene toda la pinta', 'ya te digo',
        'claro que sí', 'claro que si', 'eso está hecho', 'eso esta hecho',
        'no te preocupes', 'es una pasada', 'esto va como una seda', 'va como una seda',
        'de lujo', 'sin problema', 'así me gusta', 'asi me gusta', 'así se hace',
        'asi se hace', 'muy bien', 'todo bien', 'bien, bien', 'bien bien',
        // Ampliación StackChan v2 (26/08 22:30, frases que suelto en la calle):
        'qué ganas tenía de verte', 'que ganas tenia de verte', 'me pone de buen humor',
        'estoy de buen humor', 'vamos a por ello', 'a por ello', 'vamos allá', 'vamos alla',
        'a tope', 'a muerte', 'con ganas', 'con muchas ganas', 'vamos a darlo todo',
        'a darlo todo', 'hoy toca disfrutar', 'buen rollo', 'buena vibra', 'buenas vibras',
        'me haces feliz', 'qué alegría me das', 'que alegria me das', 'me mola', 'esto mola',
        'me alegra un montón', 'me alegra muchísimo', 'me encantó', 'me encanta esto',
        'qué bien suena', 'que bien suena', 'de maravilla', 'fenomenal', 'magnífico', 'magnifico',
        'estoy eufórico', 'eufórico', 'eufórica', 'flipando en colores', 'estoy radiante',
        '😄', '😀', '😃', '😁', '😊', '🙂', '😍', '🥰', '😘', '😎', '😇', '🤩', '😋', '😏', '🥳', '🎉', '✨', '💖', '💕', '❤️', '💜', '💙', '💚', '🧡', '💛', '🔥', '👍', '👏', '🙌', '🤗', '😻',
    ],
    sad: [
        'perdón', 'perdon', 'perdona', 'perdone', 'disculpa', 'disculpe',
        'lo siento', 'lo siento mucho', 'siento mucho', 'siento muchísimo',
        'cuánto lo siento', 'cuanto lo siento', 'perdóname', 'perdoname',
        'triste', 'tristes', 'tristeza', 'entristecido', 'entristecida',
        'melancolía', 'melancolia', 'melancólico', 'melancolica', 'nostalgia', 'nostálgico',
        'pena', 'qué pena', 'que pena', 'me da pena', 'es una pena',
        'lástima', 'qué lástima', 'que lastima', 'es una lástima',
        'qué mal', 'que mal', 'qué mal rollo', 'que mal rollo', 'mal rollo', 'vaya rollo',
        'qué bajón', 'que bajon', 'bajón', 'bajon', 'de bajón', 'de bajon', 'estoy de bajón',
        'vaya palo', 'qué palo', 'que palo', 'vaya disgusto', 'qué disgusto', 'que disgusto',
        'vaya mierda', 'vaya tela',
        'frustrante', 'frustrado', 'frustrada', 'decepción', 'decepcion',
        'decepcionado', 'decepcionada', 'desilusionado', 'desilusionada',
        'fallado', 'fracaso', 'he fracasado', 'error mío', 'error mio', 'fue culpa mía', 'fue culpa mia',
        'me duele', 'duele', 'me duele mucho', 'qué dolor', 'que dolor',
        'te echo de menos', 'echo de menos', 'te extraño', 'extraño', 'extraña',
        'os echo de menos', 'la echo de menos', 'lo echo de menos', 'te echo mucho de menos',
        'desanimado', 'desanimada', 'desanimad', 'abatido', 'abatida', 'abatid',
        'agobiado', 'agobiada', 'agobiad', 'preocupado', 'preocupada', 'preocupad',
        'angustiado', 'angustiada', 'deprimido', 'deprimida',
        'me siento solo', 'me siento sola', 'estoy solo', 'estoy sola', 'qué solo estoy', 'qué sola estoy',
        'jolín', 'jolin', 'jo, qué pena', 'jo qué pena', 'qué pena me da', 'que pena me da',
        // Ampliación StackChan v2 (26/08 22:30):
        'me siento fatal', 'me siento muy mal', 'me siento mal', 'qué mal me siento', 'que mal me siento',
        'estoy jodido', 'estoy jodida', 'estoy hundido', 'estoy hundida', 'destrozado', 'destrozada',
        'día de perros', 'dia de perros', 'vaya día de mierda', 'vaya dia de mierda', 'qué desastre', 'que desastre',
        'soy un desastre', 'lo he liado', 'la he liado', 'la he cagado', 'he metido la pata', 'mea culpa',
        'me equivoqué', 'me equivoque', 'te pido perdón', 'te pido perdon', 'te pido disculpas',
        'lo siento de verdad', 'lo siento muchísimo', 'siento muchísimo', 'siento haberte',
        'qué triste', 'que triste', 'es muy triste', 'me entristece', 'me pone triste',
        'estoy de capa caída', 'estoy de capa caida', 'vaya semanita', 'no ha sido mi día', 'no ha sido mi dia',
        '😞', '😔', '😟', '😥', '😰', '💔', '🥀',
    ],
    angry: [
        'enfadado', 'enfadada', 'enfadad', 'cabreado', 'cabreada', 'cabread',
        'cabreo', 'cabrearme', 'furioso', 'furiosa', 'furios', 'furia',
        'joder', 'jolín', 'jolin', 'joder tío', 'joder tio', 'coño', 'conio',
        'hostia', 'ostia', 'hostias', 'ostias', 'mierda', 'cojones', 'joder ya',
        'me cago en todo', 'me cago en la leche', 'me cago en mis muertos',
        'me cago en tu puta madre', 'me cago en dios', 'me cago en diez',
        'no me jodas', 'no me jodas tío', 'no me jodas tio',
        'me toca los cojones', 'me toca las narices', 'me toca los huevos', 'me toca las pelotas',
        'estoy harto', 'estoy harta', 'harto de', 'hartita', 'harto ya',
        'estoy hasta los cojones', 'estoy hasta los huevos', 'estoy hasta las narices',
        'estoy hasta el gorro', 'estoy hasta la polla', 'me tienes harto', 'me tienes hasta los cojones',
        'hastío', 'hastio', 'fastidiado', 'fastidiada', 'fastidi',
        'molesto', 'molesta', 'molest', 'rabia', 'qué rabia', 'que rabia', 'me da rabia',
        'odio', 'odiar', 'odioso', 'detesto', 'detestable', 'asqueroso', 'asquerosa', 'asqueros',
        'insoportable', 'inaguantable', 'insufrible',
        'basta ya', 'se acabó', 'se acabo', 'ya está bien', 'ya esta bien',
        'indignado', 'indignada', 'indignad', 'indignante',
        'qué pesadez', 'que pesadez', 'pesado', 'pesada', 'pesad', 'agobiante',
        'es un coñazo', 'coñazo', 'es un tostón', 'tostón', 'es un rollo',
        'que te den', 'que te den por culo', 'vete a la mierda', 'vete a tomar por culo',
        'a tomar por culo', 'cabrón', 'cabron', 'cabrona', 'gilipollas', 'gilipolla',
        'imbécil', 'imbecil', 'estúpido', 'estupido', 'estúpida', 'estupida', 'idiota',
        'tarado', 'tarada', 'subnormal', 'no puedo contigo',
        'qué asco', 'que asco', 'asco',
        // Ampliación StackChan v2 (26/08 22:30):
        'qué coño', 'que coño', 'pero qué coño', 'pero qué coño haces', 'qué cojones', 'que cojones',
        'otra vez no', 'esto es una mierda', 'es un desastre', 'menudo desastre', 'menuda mierda',
        'esto es el colmo', 'es el colmo', 'no aguanto más', 'no aguanto mas', 'no lo soporto',
        'me saca de quicio', 'me saca de mis casillas', 'me desespera', 'desesperante',
        'qué desesperación', 'que desesperacion', 'no doy crédito', 'no doy credito',
        'es inadmisible', 'es intolerable', 'siempre lo mismo', 'ya vale', 'hartísimo', 'hartisimo',
        'estoy que trino', 'estoy que echo chispas', 'echo chispas', 'jopé', 'jope', 'jopeta', 'leñe', 'ostras',
        '😠', '😡', '🤬', '👿', '💢', '😤', '🤨', '😒', '🙄',
    ],
    sleepy: [
        'sueño', 'sueno', 'tengo sueño', 'tengo sueno', 'me muero de sueño',
        'me muero de sueno', 'qué sueño', 'que sueño', 'soñoliento', 'soñolienta',
        'soñolient', 'adormilado', 'adormilada',
        'cansado', 'cansada', 'cansad', 'agotado', 'agotada', 'agotad',
        'exhausto', 'exhausta', 'exhaust', 'fatigado', 'fatigada', 'fatiga',
        'reventado', 'reventada', 'reventad', 'hecho polvo', 'estoy hecho polvo',
        'no puedo más', 'no puedo mas', 'estoy molido', 'molid',
        'dormir', 'dormido', 'dormida', 'dormid', 'dormirme', 'me voy a dormir',
        'a dormir', 'buenas noches', 'descansa', 'descansar', 'que descanses',
        // Ampliación StackChan v2 (26/08 22:30):
        'me caigo de sueño', 'me caigo de sueno', 'qué sueño tengo', 'que sueno tengo', 'vaya sueño', 'vaya sueno',
        'estoy agotadísimo', 'agotadísimo', 'agotadisimo', 'no doy más de mí', 'no doy mas de mi',
        'estoy muerto', 'estoy muerta', 'qué cansancio', 'que cansancio', 'me voy a la cama', 'a la cama',
        'me piro a dormir', 'a mimir', 'hasta mañana', 'hasta manana', 'estoy zombie', 'estoy para el arrastre',
        'para el arrastre', 'estoy hecho unos zorros', 'hecho unos zorros',
        '😴', '🥱', '💤', '🌙', '🛏️',
    ],
    doubtful: [
        // Solo DUDA real (cara de ojos entrecerrados). 26/08 22:49: quitadas
        // TODAS las palabras de SORPRESA ("no me lo puedo creer", "alucino",
        // "flipas", "me has dejado de piedra", "en serio"...): la sorpresa
        // ahora usa la cara básica de ojos abiertos (neutral).
        'no tengo ni idea', 'ni idea', 'no lo tengo claro', 'no estoy convencido',
        'no estoy convencida', 'no estoy segur', 'dud', 'dudo', 'duda', 'dudoso', 'dudosa',
        // Frases hechas de pensar/dudar de StackChan (26/08 10:50).
        'vamos a ver', 'déjame que lo mire', 'dejame que lo mire', 'déjame ver', 'dejame ver',
        'a ver qué tal', 'a ver que tal', 'no sé yo', 'no se yo', 'habrá que ver', 'habra que ver',
        // Ampliación StackChan v2 (26/08 22:30, depurada 22:49: solo duda).
        'a ver a ver', 'no sé', 'no se', 'no lo sé', 'no lo se', 'déjame pensar', 'dejame pensar',
        '🤔', '😕', '😐', '😅', '🤷',
    ],
    neutral: [],
}

// Subconjunto de ALTA CARGA: cambia la cara al instante (señal fuerte).
const STRONG_EMOTION_WORDS: Record<StackChanEmotion, string[]> = {
    laughing: ['jaja', 'jajaja', 'jajajaja', 'jeje', 'jiji', 'me parto', 'me parto de risa', 'me descojono', 'me descojono de risa', 'me meo', 'me meo de risa', 'me troncho', 'me troncho de risa', 'me cago de risa', 'me rio', 'me río', 'me estoy riendo', 'risa', 'risas', 'de risa', 'qué risa', 'que risa', 'qué gracia', 'que gracia', 'descojonante', 'tronchante', 'desternillante', 'divertidísimo', 'gracioso', 'graciosa', 'qué bueno', 'que bueno', 'es la hostia', 'es la hostia de gracioso', 'buenísimo', '😂', '🤣', '😆', '😹', '🤪'],
    crying: ['llorar', 'lloro', 'llorando', 'llora', 'lloras', 'lloriqueando', 'a llorar', 'echarme a llorar', 'echo a llorar', 'me dan ganas de llorar', 'ganas de llorar', 'sollozar', 'lágrimas', 'lagrimas', 'llorera', 'qué llanto', 'que llanto', 'me voy a poner a llorar', '😭', '😢', '😿'],
    happy: ['te quiero', 'te quiero mucho', 'te quiero un montón', 'te amo', 'te adoro', 'os quiero', 'me encanta', 'me encantan', 'me encantaría', 'me chifla', 'me flipa', 'me alucina', 'me apasiona', 'me alegra', 'me alegro', 'me alegro mucho', 'me alegra mucho', 'me alegra un montón', 'me alegra muchísimo', 'buena noticia', 'enhorabuena', 'felicidades', 'felicitaciones', 'qué bien', 'que bien', 'qué guay', 'que guay', 'qué chulo', 'que chulo', 'qué ilusión', 'que ilusion', 'qué suerte', 'que suerte', 'suertudo', 'qué pasada', 'que pasada', 'qué maravilla', 'que maravilla', 'qué bonito', 'que bonito', 'de puta madre', 'la hostia de bien', 'la leche de bien', 'alucinante', 'cojonudo', 'cojonuda', 'brutal', 'bestial', 'espectacular', 'maravilloso', 'maravillosa', 'fantástico', 'fantastico', 'estupendo', 'magnífico', 'magnifico', 'fenomenal', 'genial', 'perfecto', 'excelente', 'increíble', 'increible', 'asombroso', 'mola', 'mola mazo', 'mola un montón', 'me mola', 'me mola un montón', 'esto mola', 'guay', 'chulo', 'chula', 'molón', 'molona', 'como tú digas', 'como tu digas', 'tú marcas el ritmo', 'tu marcas el ritmo', 'lo que tú digas', 'lo que tu digas', 'cuando quieras', 'me alegro de oír eso', 'me alegro de oir eso', 'claro que sí', 'claro que si', 'eso está hecho', 'eso esta hecho', 'no te preocupes', 'es una pasada', 'va como una seda', 'esto va como una seda', 'de lujo', 'sin problema', 'así me gusta', 'asi me gusta', 'así se hace', 'asi se hace', 'muy bien', 'todo bien', 'qué ganas tenía de verte', 'que ganas tenia de verte', 'me pone de buen humor', 'estoy de buen humor', 'vamos a por ello', 'a por ello', 'vamos allá', 'vamos alla', 'a tope', 'a muerte', 'con ganas', 'con muchas ganas', 'vamos a darlo todo', 'a darlo todo', 'hoy toca disfrutar', 'buen rollo', 'buena vibra', 'buenas vibras', 'me haces feliz', 'me pone contento', 'qué alegría me das', 'que alegria me das', 'qué alegría', 'que alegria', 'feliz', 'felices', 'felicidad', 'alegre', 'alegres', 'alegría', 'alegria', 'contento', 'contenta', 'contentos', 'contentísimo', 'encantado', 'encantada', 'emocionado', 'emocionada', 'ilusionado', 'ilusionada', 'orgulloso', 'orgullosa', 'orgullo', 'precioso', 'preciosa', 'guapísimo', 'guapisimo', 'guapísima', 'guapisima', 'bravo', 'olé', 'ole', 'gracias', 'muchas gracias', 'mil gracias', 'muchísimas gracias', 'gracias por', '😍', '🥰', '😘', '❤️', '💖', '💕', '🎉', '✨', '🔥', '👍', '👏', '🙌', '🤗', '😻', '😄', '😀', '😁', '😊', '🥳'],
    angry: ['joder', 'joder tío', 'joder tio', 'joder ya', 'coño', 'conio', 'hostia', 'ostia', 'hostias', 'ostias', 'mierda', 'cojones', 'me cago en', 'me cago en todo', 'me cago en la leche', 'me cago en mis muertos', 'me cago en diez', 'no me jodas', 'no me jodas tío', 'no me jodas tio', 'me toca los', 'me toca los cojones', 'me toca las narices', 'me toca los huevos', 'me toca las pelotas', 'estoy harto', 'estoy harta', 'harto de', 'harto ya', 'hartísimo', 'hartisimo', 'estoy hasta los cojones', 'estoy hasta los huevos', 'estoy hasta las narices', 'estoy hasta el gorro', 'estoy hasta la polla', 'me tienes harto', 'basta ya', 'ya vale', 'se acabó', 'se acabo', 'se acabó lo que se daba', 'se acabo lo que se daba', 'ya está bien', 'ya esta bien', 'qué rabia', 'que rabia', 'me da rabia', 'odio', 'odiar', 'detesto', 'insoportable', 'inaguantable', 'indignado', 'indignada', 'indignante', 'es un coñazo', 'coñazo', 'es un tostón', 'tostón', 'es un rollo', 'que te den', 'que te den por culo', 'vete a la mierda', 'vete a tomar por culo', 'a tomar por culo', 'cabrón', 'cabron', 'cabrona', 'gilipollas', 'imbécil', 'imbecil', 'estúpido', 'estupido', 'estúpida', 'estupida', 'idiota', 'tarado', 'tarada', 'asqueroso', 'asquerosa', 'qué asco', 'que asco', 'asco', 'qué coño', 'que coño', 'pero qué coño', 'qué cojones', 'que cojones', 'otra vez no', 'esto es una mierda', 'es un desastre', 'menudo desastre', 'menuda mierda', 'esto es el colmo', 'es el colmo', 'no aguanto más', 'no aguanto mas', 'no lo soporto', 'me saca de quicio', 'me saca de mis casillas', 'me desespera', 'desesperante', 'qué desesperación', 'que desesperacion', 'no doy crédito', 'no doy credito', 'es inadmisible', 'es intolerable', 'siempre lo mismo', '😠', '😡', '🤬', '👿', '💢', '😤', '🤨', '😒', '🙄'],
    sad: ['lo siento', 'lo siento mucho', 'lo siento de verdad', 'lo siento muchísimo', 'siento mucho', 'siento muchísimo', 'siento haberte', 'perdón', 'perdon', 'perdona', 'perdóname', 'perdoname', 'disculpa', 'disculpe', 'te pido perdón', 'te pido perdon', 'te pido disculpas', 'mea culpa', 'fue culpa mía', 'fue culpa mia', 'error mío', 'error mio', 'me equivoqué', 'me equivoque', 'la he cagado', 'la he liado', 'he metido la pata', 'qué pena', 'que pena', 'me da pena', 'me da mucha pena', 'qué pena me da', 'que pena me da', 'es una pena', 'lástima', 'qué lástima', 'que lastima', 'me arrepiento', 'me duele', 'me duele mucho', 'qué dolor', 'que dolor', 'te echo de menos', 'te echo mucho de menos', 'te extraño', 'qué bajón', 'que bajon', 'estoy de bajón', 'estoy de bajon', 'vaya rollo', 'vaya mierda', 'vaya palo', 'qué palo', 'que palo', 'vaya disgusto', 'qué disgusto', 'que disgusto', 'decepción', 'decepcion', 'decepcionado', 'decepcionada', 'estoy decepcionado', 'estoy decepcionada', 'me siento fatal', 'me siento muy mal', 'me siento mal', 'qué mal me siento', 'que mal me siento', 'estoy jodido', 'estoy jodida', 'estoy hundido', 'estoy hundida', 'destrozado', 'destrozada', 'día de perros', 'dia de perros', 'vaya día de mierda', 'vaya dia de mierda', 'qué desastre', 'que desastre', 'soy un desastre', 'triste', 'tristes', 'tristeza', 'qué triste', 'que triste', 'es muy triste', 'me entristece', 'me pone triste', 'me pone muy triste', 'pena', 'qué mal', 'que mal', 'frustrante', 'frustrado', 'frustrada', 'agobiado', 'agobiada', 'preocupado', 'preocupada', '😞', '😔', '😟', '😥', '😰', '💔', '🥀'],
    sleepy: ['tengo sueño', 'tengo sueno', 'me muero de sueño', 'me muero de sueno', 'me caigo de sueño', 'me caigo de sueno', 'qué sueño', 'que sueño', 'qué sueño tengo', 'que sueno tengo', 'buenas noches', 'descansa', 'descansar', 'que descanses', 'dormir', 'dormido', 'dormida', 'a dormir', 'me voy a dormir', 'me piro a dormir', 'a la cama', 'me voy a la cama', 'a mimir', 'hasta mañana', 'hasta manana', 'cansado', 'cansada', 'cansad', 'agotado', 'agotada', 'agotad', 'agotadísimo', 'agotadisimo', 'exhausto', 'exhausta', 'fatigado', 'fatigada', 'reventado', 'reventada', 'reventad', 'hecho polvo', 'estoy hecho polvo', 'no puedo más', 'no puedo mas', 'no doy más de mí', 'no doy mas de mi', 'estoy muerto', 'estoy muerta', 'estoy molido', 'qué cansancio', 'que cansancio', 'vaya sueño', 'vaya sueno', 'estoy zombie', 'estoy para el arrastre', 'para el arrastre', 'estoy hecho unos zorros', '😴', '🥱', '💤', '🌙'],
    doubtful: ['no sé', 'no se', 'no lo sé', 'no lo se', 'no sé yo', 'no se yo', 'no tengo ni idea', 'ni idea', 'no lo tengo claro', 'no estoy convencido', 'no estoy segur', 'dudo', 'duda', 'vamos a ver', 'déjame que lo mire', 'dejame que lo mire', 'déjame ver', 'dejame ver', 'déjame pensar', 'dejame pensar', 'habrá que ver', 'habra que ver', '🤔', '😕', '😐', '😅', '🤷'],
    neutral: [],
}

function buildEmotionRe(words: string[]): RegExp {
    if (words.length === 0) return /^$/u
    const parts = words.map(w => (w.includes('\\b') ? w : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return new RegExp(parts.join('|'), 'u')
}

const EMOTION_RE: Record<StackChanEmotion, RegExp> = {
    laughing: buildEmotionRe(EMOTION_WORDS.laughing),
    crying: buildEmotionRe(EMOTION_WORDS.crying),
    happy: buildEmotionRe(EMOTION_WORDS.happy),
    sad: buildEmotionRe(EMOTION_WORDS.sad),
    angry: buildEmotionRe(EMOTION_WORDS.angry),
    sleepy: buildEmotionRe(EMOTION_WORDS.sleepy),
    doubtful: buildEmotionRe(EMOTION_WORDS.doubtful),
    neutral: buildEmotionRe(EMOTION_WORDS.neutral),
}

const STRONG_EMOTION_RE: Record<StackChanEmotion, RegExp> = {
    laughing: buildEmotionRe(STRONG_EMOTION_WORDS.laughing),
    crying: buildEmotionRe(STRONG_EMOTION_WORDS.crying),
    happy: buildEmotionRe(STRONG_EMOTION_WORDS.happy),
    sad: buildEmotionRe(STRONG_EMOTION_WORDS.sad),
    angry: buildEmotionRe(STRONG_EMOTION_WORDS.angry),
    sleepy: buildEmotionRe(STRONG_EMOTION_WORDS.sleepy),
    doubtful: buildEmotionRe(STRONG_EMOTION_WORDS.doubtful),
    neutral: buildEmotionRe(STRONG_EMOTION_WORDS.neutral),
}

export function inferStackChanEmotion(text: string): StackChanEmotion {
    const normalized = stripMediaForSpeech(text).toLowerCase()

    // Orden de prioridad: risa → llanto → feliz → triste → enfado → sueño → duda.
    // El firmware solo soporta estas emociones; cualquier otra → neutral.
    const order: StackChanEmotion[] = ['laughing', 'crying', 'happy', 'sad', 'angry', 'sleepy', 'doubtful']
    for (const emotion of order) {
        if (EMOTION_RE[emotion].test(normalized)) return emotion
    }
    return 'neutral'
}

// STRONG_EMOTION_RE construido desde STRONG_EMOTION_WORDS (ver arriba).
// Palabras de alta carga → cambio inmediato de cara.

/**
 * StackChan 26/08 08:24: tracker de emociones con MEMORIA e INERCIA para que la
 * cara del robot cambie de forma orgánica y natural, no como un semáforo.
 *
 * Cómo funciona:
 * - La cara MANTIENE la emoción actual mientras no haya una señal fuerte.
 * - Señal fuerte (emoticono o palabra de alta carga) -> cambio inmediato.
 * - Señal débil (palabra suave) -> solo cambia si es consistente (2+ de las
 *   últimas 3 frases), para no dar saltos por una frase suelta.
 * - Frase neutra -> inercia: se queda la cara actual, no resetea a neutral.
 */
// StackChan v10.13 (26/08/2026): expresiones de amor que disparan la decoración
// de corazón en la carita (self.display.show_heart). Siempre que salgan en
// una frase -> corazón.
const LOVE_EXPRESSION_RE =
    /(te quiero|te amo|te adoro|me encantas|te echo de menos|os quiero|estoy enamorado|estoy enamorada|me gustas mucho|me tienes loco|me tienes loca)/i

export class StackChanEmotionTracker {
    private _current: StackChanEmotion = 'neutral'
    private _history: string[] = []

    get current(): StackChanEmotion {
        return this._current
    }

    reset(initial: StackChanEmotion = 'neutral'): void {
        this._current = initial
        this._history = []
    }

    update(segment: string): StackChanEmotion {
        const normalized = stripMediaForSpeech(segment).toLowerCase()
        this._history.push(normalized)
        if (this._history.length > 4) this._history.shift()

        // 1) Señal fuerte -> cambio inmediato
        for (const [emotion, re] of Object.entries(STRONG_EMOTION_RE) as [StackChanEmotion, RegExp][]) {
            if (emotion !== 'neutral' && re.test(normalized)) {
                this._current = emotion
                return emotion
            }
        }

        // 2) Señal débil -> solo si es consistente (2+ votos en las últimas 3 frases)
        const recent = this._history.slice(-3)
        const votes = new Map<StackChanEmotion, number>()
        for (const phrase of recent) {
            const detected = inferStackChanEmotion(phrase)
            if (detected !== 'neutral') {
                votes.set(detected, (votes.get(detected) ?? 0) + 1)
            }
        }
        for (const [emotion, count] of votes) {
            if (count >= 2) {
                this._current = emotion
                return emotion
            }
        }

        // 3) Sin señal consistente: volver a la cara base (ojos abiertos / neutral)
        this._current = 'neutral'
        return 'neutral'
    }
}

export function limitStackChanSpeechText(text: string, maxChars = MAX_SPEECH_TEXT_CHARS): string {
    const stripped = stripMediaForSpeech(text).replace(/\s+/g, ' ').trim()
    if (stripped.length <= maxChars) return stripped
    return `${stripped.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

function normalizeSpeechText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n+ */g, '\n')
        .trim()
}

function splitLongSegment(segment: string, maxChars: number): string[] {
    if (segment.length <= maxChars) return [segment]
    const chunks: string[] = []
    let rest = segment
    while (rest.length > maxChars) {
        let splitAt = -1
        const window = rest.slice(0, maxChars + 1)
        for (const marker of ['、', '，', ',', ' ']) {
            const idx = window.lastIndexOf(marker)
            if (idx > Math.floor(maxChars * 0.45)) {
                splitAt = idx + 1
                break
            }
        }
        if (splitAt <= 0) splitAt = maxChars
        chunks.push(rest.slice(0, splitAt).trim())
        rest = rest.slice(splitAt).trim()
    }
    if (rest) chunks.push(rest)
    return chunks.filter(Boolean)
}

export function splitStackChanSpeechText(
    text: string,
    config: SpeechSegmentationConfig = SPEECH_SEGMENTATION_CONFIG,
    fallback = '画像を表示しました。',
): string[] {
    let speech = normalizeSpeechText(stripMediaForSpeech(text))
    if (!speech) speech = fallback
    if (speech.length > config.maxSpeechChars) {
        speech = `${speech.slice(0, Math.max(1, config.maxSpeechChars - 1)).trimEnd()}…`
    }

    const rawSegments: string[] = []
    let current = ''
    for (let i = 0; i < speech.length; i++) {
        const ch = speech[i]
        if (ch === '\n') {
            if (current.trim()) rawSegments.push(current.trim())
            current = ''
            continue
        }
        current += ch
        const prev = i > 0 ? speech[i - 1] : ''
        const next = i + 1 < speech.length ? speech[i + 1] : ''
        const isSentenceEnd = /[。！？!?]/.test(ch) ||
            (ch === '.' && !/\d/.test(prev) && !/\d/.test(next))
        if (isSentenceEnd) {
            if (current.trim()) rawSegments.push(current.trim())
            current = ''
        }
    }
    if (current.trim()) rawSegments.push(current.trim())

    const segments = rawSegments.flatMap(segment => splitLongSegment(segment, config.segmentMaxChars))
    return segments.filter(Boolean).slice(0, config.maxSegments)
}

function stableSpeechSegmentsFromPartialReply(
    text: string,
    config: SpeechSegmentationConfig = SPEECH_SEGMENTATION_CONFIG,
): string[] {
    const speech = normalizeSpeechText(stripMediaForSpeech(text))
    if (!speech) return []
    const segments = splitStackChanSpeechText(text, config, '')
    if (segments.length === 0) return []
    if (/[。！？!?\n]$/.test(speech)) return segments
    return segments.slice(0, -1)
}

/**
 * After streaming TTS, determine which final segments still need to be spoken.
 * We can't just slice by count because streaming stable segments may split at
 * different boundaries than the final segments. Instead, we track the actual text
 * that was spoken and re-join/re-split the remainder.
 */
function computeRemainingSegments(fullReply: string, spokenText: string, finalSegments: string[]): string[] {
    const spokenNorm = normalizeSpeechText(spokenText).trim()
    if (!spokenNorm) return finalSegments
    // Walk through final segments and accumulate until we've covered all spoken text
    let acc = ''
    let skipIdx = 0
    for (let i = 0; i < finalSegments.length; i++) {
        acc += finalSegments[i]
        const accNorm = normalizeSpeechText(acc).trim()
        // If we've matched or exceeded the spoken text, skip through this segment
        if (accNorm === spokenNorm) {
            skipIdx = i + 1
            break
        }
        if (accNorm.length >= spokenNorm.length && accNorm.startsWith(spokenNorm)) {
            // Spoken text is a prefix of accumulated segments — partial segment match.
            // Re-derive the unspoken portion of this segment.
            const remainder = finalSegments[i].slice(spokenNorm.length - normalizeSpeechText(acc.slice(0, acc.length - finalSegments[i].length)).trim().length)
            const remaining = [remainder, ...finalSegments.slice(i + 1)].filter(Boolean)
            return remaining.length > 0 ? remaining : []
        }
        skipIdx = i + 1
    }
    return finalSegments.slice(skipIdx)
}

// auto モード: フレームが途切れてから処理開始するまでの無音判定時間 (ms)
const TURN_CONTROL_CONFIG = readTurnControlConfig()
const SILENCE_TIMEOUT_MS = TURN_CONTROL_CONFIG.silenceTimeoutMs
// 最長録音時間 (ms) — 無音検知がなくても強制処理
const MAX_RECORDING_MS = TURN_CONTROL_CONFIG.maxRecordingMs
// STT を呼ぶ最低フレーム数 (10フレーム × 60ms = 600ms 未満は無音とみなす)
const MIN_FRAMES_FOR_STT = TURN_CONTROL_CONFIG.minFramesForStt
// TTS 再生後、次の listen start を受け付けるまでのクールダウン (ms) — エコー誤検知防止
const POST_TTS_COOLDOWN_MS = TURN_CONTROL_CONFIG.postTtsCooldownMs
const BARGE_IN_CONFIG = readBargeInConfig()
const SPEECH_SEGMENTATION_CONFIG = readSpeechSegmentationConfig()
const AUTO_LED_CONFIG = readAutoLedConfig()
const MAX_SPEECH_TEXT_CHARS = SPEECH_SEGMENTATION_CONFIG.maxSpeechChars
const MCP_REQUEST_TIMEOUT_MS = 10_000
const PROCESSING_KEEPALIVE_MS = 10_000
const PROCESS_ERROR_SPEECH = '返答処理でエラーが起きました。設定とサーバーログを確認してください。'
const PROCESS_ERROR_ALERT_MAX_CHARS = 120
const AUTO_RESUME_LISTENING = readEnvBool('STACKCHAN_AUTO_RESUME_LISTENING', true)
const IGNORE_SHORT_TRANSCRIPTS = readEnvBool('STACKCHAN_IGNORE_SHORT_TRANSCRIPTS', true)
// StackChan 26/08 10:14: modo TRACKER ONLY — si STACKCHAN_TRACKER_ONLY=true,
// se silencian los 'doubtful' del sistema viejo (procesamiento) y solo el
// StackChanEmotionTracker mueve la cara. Para el test A/B emociones.
const TRACKER_ONLY_MODE = readEnvBool('STACKCHAN_TRACKER_ONLY', false)
const TTS_PREROLL_MS = readEnvInt('STACKCHAN_TTS_PREROLL_MS', 0, 0, 600)

// StackChan 25/08 21:27: PRE-BUFFER como la china (sendAudioHandle.py PRE_BUFFER_COUNT=5).
// Los primeros N frames se envían DE GOLPE para llenar la cola del firmware (300ms de
// colchón) y absorber el jitter de red; después, pacing de 60ms. Sin esto, el buffer del
// firmware se vacía (underrun) → microcortes/interferencia.
const TTS_PRE_BUFFER_FRAMES = readEnvInt('STACKCHAN_TTS_PRE_BUFFER_FRAMES', 5, 0, 20)
const FAST_ACK_ENABLED = readEnvBool('STACKCHAN_FAST_ACK_ENABLED', false)
const FAST_ACK_TEXT = (process.env.STACKCHAN_FAST_ACK_TEXT ?? 'はい。').trim() || 'はい。'
const FAST_ACK_TEXTS = readFastAckTexts()
const STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS = readEnvBool('STACKCHAN_STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS', true)
const MAX_DURATION_STT_RMS_THRESHOLD = readEnvFloat('STACKCHAN_MAX_DURATION_STT_RMS_THRESHOLD', 0.006, 0, 0.2)
const BOOT_VOLUME = readEnvInt('STACKCHAN_BOOT_VOLUME', 0, 0, 100, process.env)
const STREAMING_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_STREAMING_DECODE_FAILURE_LIMIT', 3, 1, 20)
const BARGE_IN_DECODE_FAILURE_LIMIT = readEnvInt('STACKCHAN_BARGE_IN_DECODE_FAILURE_LIMIT', 3, 1, 20)
const DEFAULT_IGNORED_SHORT_TRANSCRIPTS = new Set([
    'あ', 'あっ', 'あー',
    'え', 'えっ', 'えー',
    'お', 'おっ',
    'はい', 'うん', 'ん',
    '了解', 'なるほど', 'わかった', 'OK', 'オーケー',
    'はは', 'ハハ', 'ふふ', 'フフ',
    'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ',
])
const DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS = new Set(['あ', 'あっ', 'あー', 'え', 'えっ', 'えー', 'お', 'おっ', 'うん', 'ん', 'はい', 'はは', 'ハハ', 'ふふ', 'フフ', 'ちっ', 'チッ', 'ふっ', 'フッ', 'くっ', 'クッ'])

type FastAckCacheEntry = {
    text: string
    wav: Buffer
    frames: Buffer[]
}

function readFastAckTexts(): string[] {
    const raw = process.env.STACKCHAN_FAST_ACK_TEXTS?.trim()
    const values = raw
        ? raw.split(/[|\n]/g).map(item => item.trim()).filter(Boolean)
        : [FAST_ACK_TEXT]
    return [...new Set(values)].slice(0, 16)
}

function stackChanVoicePrompt(prompt: string): string {
    const prefix = process.env.STACKCHAN_REPLY_PROMPT_PREFIX?.trim()
    if (!prefix) return prompt
    return `${prefix}\nユーザー: ${prompt}`
}

function normalizedShortTranscript(text: string): string {
    return text
        .normalize('NFKC')
        .trim()
        .replace(/[、。！？!?\s]/g, '')
        .replace(/[ー〜~]+$/g, 'ー')
}

export function isIgnorableShortTranscript(text: string): boolean {
    if (!IGNORE_SHORT_TRANSCRIPTS) return false
    const normalized = normalizedShortTranscript(text)
    if (!normalized) return false

    const configured = process.env.STACKCHAN_IGNORED_SHORT_TRANSCRIPTS
    const ignored = configured
        ? new Set(configured.split(',').map(item => normalizedShortTranscript(item)).filter(Boolean))
        : DEFAULT_IGNORED_SHORT_TRANSCRIPTS
    return ignored.has(normalized)
}

export function isIgnorableTimeoutTranscript(text: string): boolean {
    if (!IGNORE_SHORT_TRANSCRIPTS) return false
    const normalized = normalizedShortTranscript(text)
    if (!normalized) return false
    return DEFAULT_IGNORED_TIMEOUT_TRANSCRIPTS.has(normalized)
}

function isMissingSttProviderError(message: string): boolean {
    return /No STT provider available/i.test(message)
}

function compactErrorForBubble(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error)
    const compact = raw.replace(/\s+/g, ' ').trim()
    if (!compact) return 'unknown error'
    if (isMissingSttProviderError(compact)) return 'STT設定がありません。サーバー設定を確認してください。'
    if (compact.length <= PROCESS_ERROR_ALERT_MAX_CHARS) return compact
    return `${compact.slice(0, PROCESS_ERROR_ALERT_MAX_CHARS - 3)}...`
}

function buildProcessingErrorAlertMessage(error: unknown): string {
    return `HERMES AI server error: ${compactErrorForBubble(error)}`
}
type AutoLedState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

type PendingMcpRequest = {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
}

type HermesSessionClient = {
    submitPrompt(prompt: string): Promise<string>
    streamPrompt?(prompt: string): AsyncIterable<HermesPromptStreamEvent>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}

type TtsPlayback = {
    generation: number
    label: string
    streamStartMs: number
    streamedFrames: number
    segmentCount: number
    interrupted: boolean
    firstFrameLogged: boolean
    firstAudibleFrameLogged: boolean
    localOutputChecked: boolean
    localOutputTarget?: string
    m5SpeakerMutedForLocalOutput: boolean
}

type SynthesizedSegment = {
    wav: Buffer
    opusFrames: Buffer[]
}

type PrefetchedSegment = {
    index: number
    promise: Promise<SynthesizedSegment>
}

type SessionDeps = {
    hermes?: HermesSessionClient
    deviceBinding?: DeviceBinding
    deviceId?: string
    registerDeviceSession?: typeof registerDeviceSession
    decodeOpusFrames?: typeof decodeOpusFrames
    createInputOpusDecoder?: typeof createInputOpusDecoder
    decodeOpusFrame?: (opus: Buffer) => Buffer
    encodeWavToOpusFrames?: typeof encodeWavToOpusFrames
    transcribeWav?: typeof transcribeWithHermes
    synthesizeText?: typeof synthesizeWithHermes
    postTtsCooldownMs?: number
    localVadConfig?: LocalRmsVadConfig
    bargeInConfig?: BargeInConfig
    speechSegmentationConfig?: SpeechSegmentationConfig
    autoLedConfig?: AutoLedConfig
    bargeInEnabled?: boolean
    autoLedEnabled?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export class Session {
    private readonly sessionId = randomUUID()
    private state: State = 'idle'
    private _emotionTracker = new StackChanEmotionTracker()
    private version = 3
    private opusFrames: Buffer[] = []
    // StackChan v10.9.7: frames de audio a descartar tras un wake word.
    // El firmware envía el audio residual del wake word como primeros frames;
    // si no se descartan, el STT transcribe "¿Qué?" (whisper alucina con el
    // ruido del wake word) y el LLM responde a eso. La app china los ignora.
    private wakeWordSkipFrames = 0
    private hermes: HermesSessionClient
    private readonly unregisterDeviceSession: () => void
    private readonly decodeOpusFramesFn: typeof decodeOpusFrames
    private readonly createInputOpusDecoderFn: typeof createInputOpusDecoder
    private readonly decodeOpusFrameFn?: (opus: Buffer) => Buffer
    private readonly encodeWavToOpusFramesFn: typeof encodeWavToOpusFrames
    private readonly transcribeWavFn: typeof transcribeWithHermes
    private readonly synthesizeTextFn: typeof synthesizeWithHermes
    private readonly localVadConfig: LocalRmsVadConfig
    private readonly localVad: LocalRmsVad
    private readonly bargeInConfig: BargeInConfig
    private readonly bargeInVad: LocalRmsVad
    private readonly speechSegmentationConfig: SpeechSegmentationConfig
    private readonly autoLedConfig: AutoLedConfig
    private readonly localTtsOutputConfig: LocalTtsOutputConfig
    private readonly pendingMcp = new Map<number, PendingMcpRequest>()
    private nextMcpId = 1
    private silenceTimer?: ReturnType<typeof setTimeout>
    private maxDurationTimer?: ReturnType<typeof setTimeout>
    private delayedListenTimer?: ReturnType<typeof setTimeout>
    private cooldownUntil = 0
    private readonly postTtsCooldownMs: number
    private pcmChunks: Buffer[] = []
    private preRollPcmChunks: Buffer[] = []
    private streamingDecoder: InputOpusDecoder
    private streamingDecodeFailed = false
    private streamingDecodeFailures = 0
    private bargeInDecoder: InputOpusDecoder
    private bargeInDecodeFailed = false
    private bargeInDecodeFailures = 0
    private ttsStreaming = false
    private ttsStopSent = false
    private ttsGeneration = 0
    private ttsStartedAt = 0
    private manualLedHoldUntil = 0
    private lastAutoLedState?: AutoLedState
    private lastListenMode = ''
    private processingSource: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap' = 'arrival-gap'
    private currentSpeechMs = 0
    private followupQueue: string[] = []
    private followupRunning = false
    private fastAckEntries?: FastAckCacheEntry[]
    private fastAckFailed = false
    private lastFastAckIndex = -1
    private closed = false

    constructor(private readonly ws: WebSocket, deps: SessionDeps = {}) {
        // Per-device backend selection: read binding from WS handshake (Device-Id header)
        // Falls back to devices.json default, then to env var for backwards compat
        const binding = deps.deviceBinding ?? { backend: (process.env.STACKCHAN_BACKEND ?? 'hermes') as 'openclaw' | 'hermes', agent_id: process.env.STACKCHAN_AGENT_ID ?? 'your-agent' }
        const deviceId = deps.deviceId ?? 'unknown'
        this.hermes = deps.hermes ?? (binding.backend === 'openclaw' ? new OpenClawClient({ agentId: binding.agent_id, deviceId }) : new HermesClient())
        this.decodeOpusFramesFn = deps.decodeOpusFrames ?? decodeOpusFrames
        this.createInputOpusDecoderFn = deps.createInputOpusDecoder ?? createInputOpusDecoder
        this.decodeOpusFrameFn = deps.decodeOpusFrame
        this.encodeWavToOpusFramesFn = deps.encodeWavToOpusFrames ?? encodeWavToOpusFrames
        this.transcribeWavFn = deps.transcribeWav ?? transcribeWithHermes
        this.synthesizeTextFn = deps.synthesizeText ?? synthesizeWithHermes
        this.postTtsCooldownMs = deps.postTtsCooldownMs ?? POST_TTS_COOLDOWN_MS
        this.localVadConfig = deps.localVadConfig ?? readLocalRmsVadConfig()
        this.localVad = new LocalRmsVad(this.localVadConfig)
        this.bargeInConfig = { ...(deps.bargeInConfig ?? BARGE_IN_CONFIG) }
        if (typeof deps.bargeInEnabled === 'boolean') this.bargeInConfig.enabled = deps.bargeInEnabled
        this.bargeInVad = new LocalRmsVad({
            enabled: this.bargeInConfig.enabled,
            rmsThreshold: this.bargeInConfig.rmsThreshold,
            startSpeechMs: this.bargeInConfig.startSpeechMs,
            endSilenceMs: 1000,
            minSpeechMs: this.bargeInConfig.minSpeechMs,
            preRollMs: 0,
        })
        this.speechSegmentationConfig = deps.speechSegmentationConfig ?? SPEECH_SEGMENTATION_CONFIG
        this.autoLedConfig = { ...(deps.autoLedConfig ?? AUTO_LED_CONFIG) }
        this.localTtsOutputConfig = readLocalTtsOutputConfig()
        if (typeof deps.autoLedEnabled === 'boolean') this.autoLedConfig.enabled = deps.autoLedEnabled
        this.streamingDecoder = this.createInputOpusDecoderFn()
        this.bargeInDecoder = this.createInputOpusDecoderFn()
        this.unregisterDeviceSession = (deps.registerDeviceSession ?? registerDeviceSession)(this)
        if (FAST_ACK_ENABLED) void this.warmFastAck()
    }

    abort(): void {
        this.clearTimers()
        this.sendTtsStopOnce(this.ttsGeneration)
        this.ttsGeneration += 1
        this.ttsStreaming = false
        this.cooldownUntil = 0
        this.state = 'idle'
        this.resetCapture()
        this.resetBargeInDetector()
        this.followupQueue = []
        this.setAutoLedState('idle')
        void this.hermes.interrupt().catch((error) => {
            console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error)
        })
    }

    /**
     * StackChan v10.9: cierre real estilo app china ("desconecta").
     * Cierra el WebSocket del dispositivo para que el firmware reaccione
     * como la nube china: OnDisconnected -> on_audio_channel_closed_ ->
     * idle + LOW_POWER + micro apagado (sin temporizador).
     */
    closeDeviceConnection(): void {
        try {
            this.ws.close()
        } catch (error) {
            console.error(`[session ${this.sessionId}] ws close error:`, error)
        }
    }

    close(): void {
        this.closed = true
        this.followupQueue = []
        this.clearTimers()
        this.unregisterDeviceSession()
        // StackChan fix v10.4: proteccion anti-crash (opusscript dispose puede lanzar
        // RuntimeError wasm en Node 26). Los decoders se recrean al resetear.
        try {
            this.streamingDecoder.dispose()
        } catch {
            /* noop */
        }
        try {
            this.bargeInDecoder.dispose()
        } catch {
            /* noop */
        }
        for (const [id, pending] of this.pendingMcp) {
            clearTimeout(pending.timer)
            pending.reject(new Error('StackChan WebSocket disconnected'))
            this.pendingMcp.delete(id)
        }
        void this.hermes.dispose()
    }

    handleMessage(data: Buffer | string): void {
        if (typeof data === 'string') {
            try {
                this.handleJson(JSON.parse(data) as Record<string, unknown>)
            } catch (e) {
                console.error('[session] JSON parse error:', e)
            }
        } else {
            const str = data.toString('utf8')
            if (str.startsWith('{') || str.startsWith('[')) {
                try {
                    this.handleJson(JSON.parse(str) as Record<string, unknown>)
                    return
                } catch {
                    // JSON でなければバイナリとして処理
                }
            }
            this.handleBinary(data)
        }
    }

    private handleBinary(data: Buffer): void {
        const payload = extractOpusPayload(data, this.version)
        if (!payload) return

        if (this.state === 'processing') {
            this.tryHandleBargeIn(payload)
            return
        }

        if (this.state !== 'listening') return
        this.handleListeningPayload(payload)
    }

    private handleListeningPayload(payload: Buffer): void {
        // StackChan v10.9.7: descartar frames residuales del wake word
        if (this.wakeWordSkipFrames > 0) {
            this.wakeWordSkipFrames -= 1
            return
        }
        this.opusFrames.push(payload)
        if (this.shouldUseLocalVad()) {
            this.handleVadPayload(payload)
        } else {
            this.resetSilenceTimer()
        }
    }

    private shouldUseLocalVad(): boolean {
        return this.localVadConfig.enabled && !this.streamingDecodeFailed
    }

    private handleVadPayload(payload: Buffer): void {
        let pcm: Buffer
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.streamingDecoder.decodeFrame(payload)
        } catch (error) {
            this.streamingDecodeFailures += 1
            this.recreateStreamingDecoder()
            this.localVad.reset()
            this.pcmChunks = []
            this.currentSpeechMs = 0
            if (this.streamingDecodeFailures >= STREAMING_DECODE_FAILURE_LIMIT) {
                this.streamingDecodeFailed = true
                console.warn(`[session ${this.sessionId}] local VAD streaming decode failed ${this.streamingDecodeFailures} times, using arrival-gap timeout: ${String(error)}`)
            } else {
                console.warn(`[session ${this.sessionId}] local VAD streaming decode skipped invalid frame ${this.streamingDecodeFailures}/${STREAMING_DECODE_FAILURE_LIMIT}: ${String(error)}`)
            }
            this.resetSilenceTimer()
            return
        }
        this.streamingDecodeFailures = 0
        if (pcm.length === 0) return

        const collectingBefore = this.pcmChunks.length > 0
        if (collectingBefore) {
            this.pcmChunks.push(pcm)
        } else {
            this.appendPreRollPcm(pcm)
        }

        const result = this.localVad.processPcm(pcm)
        this.currentSpeechMs = result.speechMs

        if (result.speechStarted && this.pcmChunks.length === 0) {
            this.pcmChunks = this.preRollPcmChunks.splice(0)
            this.armMaxDurationTimer()
            console.log(`[session ${this.sessionId}] vad speech started rms=${result.rms.toFixed(4)}`)
        }

        if (result.ignoredShortSpeech) {
            console.log(`[session ${this.sessionId}] vad ignored short speech speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.preRollPcmChunks = this.pcmChunks.splice(0)
            this.localVad.reset()
            this.currentSpeechMs = 0
            return
        }

        if (result.utteranceEnded) {
            console.log(`[session ${this.sessionId}] vad silence ended speechMs=${result.speechMs} silenceMs=${result.silenceMs}`)
            this.triggerProcess('local-vad')
        }
    }

    private appendPreRollPcm(pcm: Buffer): void {
        if (this.localVadConfig.preRollMs <= 0) {
            this.preRollPcmChunks = []
            return
        }
        this.preRollPcmChunks.push(pcm)
        const maxChunks = Math.max(1, Math.ceil(this.localVadConfig.preRollMs / INPUT_FRAME_DURATION_MS))
        while (this.preRollPcmChunks.length > maxChunks) {
            this.preRollPcmChunks.shift()
        }
    }

    private resetSilenceTimer(): void {
        if (this.silenceTimer) clearTimeout(this.silenceTimer)
        this.silenceTimer = setTimeout(() => {
            console.log(`[session ${this.sessionId}] silence detected, triggering process`)
            this.triggerProcess('arrival-gap')
        }, SILENCE_TIMEOUT_MS)
    }

    private clearTimers(): void {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = undefined }
        if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = undefined }
        if (this.delayedListenTimer) { clearTimeout(this.delayedListenTimer); this.delayedListenTimer = undefined }
    }

    private resetVadBuffers(): void {
        this.localVad.reset()
        this.pcmChunks = []
        this.preRollPcmChunks = []
        this.currentSpeechMs = 0
    }

    private resetCapture(): void {
        this.opusFrames = []
        this.resetVadBuffers()
        this.recreateStreamingDecoder()
        this.streamingDecodeFailed = false
        this.streamingDecodeFailures = 0
    }

    private resetBargeInDetector(): void {
        this.bargeInVad.reset()
        this.recreateBargeInDecoder()
        this.bargeInDecodeFailed = false
        this.bargeInDecodeFailures = 0
    }

    private recreateStreamingDecoder(): void {
        try {
            this.streamingDecoder.dispose()
        } catch {
            /* noop */
        }
        this.streamingDecoder = this.createInputOpusDecoderFn()
    }

    private recreateBargeInDecoder(): void {
        try {
            this.bargeInDecoder.dispose()
        } catch {
            /* noop */
        }
        this.bargeInDecoder = this.createInputOpusDecoderFn()
    }

    private tryHandleBargeIn(payload: Buffer): boolean {
        if (!this.bargeInConfig.enabled || this.bargeInDecodeFailed) return false
        if (!this.ttsStreaming) return false
        if (Date.now() - this.ttsStartedAt < this.bargeInConfig.ignoreTtsStartMs) return false

        let pcm: Buffer
        try {
            pcm = this.decodeOpusFrameFn ? this.decodeOpusFrameFn(payload) : this.bargeInDecoder.decodeFrame(payload)
        } catch (error) {
            this.bargeInDecodeFailures += 1
            this.bargeInVad.reset()
            this.recreateBargeInDecoder()
            if (this.bargeInDecodeFailures >= BARGE_IN_DECODE_FAILURE_LIMIT) {
                this.bargeInDecodeFailed = true
                console.warn(`[session ${this.sessionId}] barge-in decode failed ${this.bargeInDecodeFailures} times, disabled for current TTS: ${String(error)}`)
            } else {
                console.warn(`[session ${this.sessionId}] barge-in decode skipped invalid frame ${this.bargeInDecodeFailures}/${BARGE_IN_DECODE_FAILURE_LIMIT}: ${String(error)}`)
            }
            return false
        }
        this.bargeInDecodeFailures = 0

        const result = this.bargeInVad.processPcm(pcm)
        if (!result.inSpeech || result.speechMs < this.bargeInConfig.minSpeechMs) return false

        console.log(`[session ${this.sessionId}] barge-in detected rms=${result.rms.toFixed(4)} speechMs=${result.speechMs}`)
        this.handleBargeIn(payload)
        return true
    }

    private handleBargeIn(firstPayload: Buffer): void {
        const interruptedGeneration = this.ttsGeneration
        this.sendTtsStopOnce(interruptedGeneration)
        this.ttsGeneration += 1
        this.ttsStreaming = false
        this.cooldownUntil = 0
        this.clearTimers()
        this.resetCapture()
        this.resetBargeInDetector()
        void this.hermes.interrupt().catch((error) => {
            console.error(`[session ${this.sessionId}] Hermes interrupt error:`, error)
        })
        this.startListening('barge-in')
        this.setAutoLedState('listening')
        this.handleListeningPayload(firstPayload)
    }

    private triggerProcess(reason: 'local-vad' | 'listen-stop' | 'max-duration' | 'arrival-gap', force = false): void {
        if (this.state !== 'listening') return
        this.clearTimers()
        const hasVadPcm = this.pcmChunks.length > 0
        const pcmBytes = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const minPcmBytes = Math.ceil((this.localVadConfig.minSpeechMs / 1000) * INPUT_SAMPLE_RATE) * 2
        if (!force && hasVadPcm && (this.currentSpeechMs < this.localVadConfig.minSpeechMs || pcmBytes < minPcmBytes)) {
            console.log(`[session ${this.sessionId}] too little VAD speech speechMs=${this.currentSpeechMs} pcmBytes=${pcmBytes}, restarting listen`)
            this.resetCapture()
            this.startListening('short-speech')
            return
        }
        if (!force && !hasVadPcm && this.opusFrames.length < MIN_FRAMES_FOR_STT) {
            console.log(`[session ${this.sessionId}] too few frames (${this.opusFrames.length}), restarting listen`)
            this.resetCapture()
            this.startListening('too-few-frames')
            return
        }
        this.processingSource = reason
        this.state = 'processing'
        this.setAutoLedState('thinking')
        this.process().catch(async (err) => {
            console.error(`[session ${this.sessionId}] process error:`, err)
            this.setAutoLedState('error')
            this.sendProcessingErrorAlert(err)
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.error').catch((error) => {
                    console.error(`[session ${this.sessionId}] error speech failed:`, error)
                })
                this.sendProcessingErrorAlert(err)
            }
        }).finally(() => {
            if (this.state === 'processing') {
                if (this.shouldAutoResumeListening()) {
                    this.state = 'idle'
                    this.setAutoLedState('idle')
                    if (Date.now() < this.cooldownUntil) {
                        this.delayListeningUntilCooldownEnds('post-tts')
                    } else {
                        this.startListening('post-tts')
                    }
                } else {
                    this.state = 'idle'
                    this.setAutoLedState('idle')
                }
            }
            this.drainFollowupQueue()
        })
    }

    private shouldAutoResumeListening(): boolean {
        return AUTO_RESUME_LISTENING &&
            (this.lastListenMode === 'realtime' || this.lastListenMode === 'auto') &&
            !this.closed
    }

    private startListening(source: string): void {
        this.clearTimers()
        this.state = 'listening'
        this.resetCapture()
        // StackChan v10.9.7: si el listen arranca por wake word, descartar los
        // primeros ~1.8s de audio (residual del wake word + codificación)
        // para que el STT no transcriba "¿Qué?" ni ruido del wake word.
        const wakeSkip = source.startsWith('wake_word=')
            ? Math.ceil(1800 / INPUT_FRAME_DURATION_MS)
            : 0
        // Fix StackChan 2026-08-26: tras detectar la wake word, el firmware manda
        // un 'mode=auto' de refuerzo justo después. Ese segundo start llegaba
        // con source 'mode=auto' → wakeSkip=0 y RESETEABA el skip a 0, dejando
        // pasar el residuo de la wake word al STT → whisper alucinaba
        // ("suscríbete al canal"). Conservamos el skip pendiente de la wake
        // word si ya estábamos en plena ventana, para que NO se cuele ese
        // residuo al transcribir.
        this.wakeWordSkipFrames = wakeSkip > 0 ? wakeSkip : this.wakeWordSkipFrames
        this.setAutoLedState('listening')
        if (!this.localVadConfig.enabled) {
            console.log(`[session ${this.sessionId}] local vad disabled, using arrival-gap timeout`)
        }
        this.armMaxDurationTimer()
        console.log(`[session ${this.sessionId}] listening started (${source}, skip ${this.wakeWordSkipFrames} wake word frames)`)
    }

    private armMaxDurationTimer(): void {
        if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer)
        this.maxDurationTimer = setTimeout(() => {
            if (this.shouldUseLocalVad() && this.pcmChunks.length === 0 && this.currentSpeechMs === 0) {
                console.log(`[session ${this.sessionId}] max duration reached without VAD speech, restarting listen`)
                this.resetCapture()
                this.startListening('empty-timeout')
                return
            }
            console.log(`[session ${this.sessionId}] max duration reached, triggering process`)
            this.triggerProcess('max-duration', true)
        }, MAX_RECORDING_MS)
    }

    private delayListeningUntilCooldownEnds(source: string): void {
        if (this.delayedListenTimer) clearTimeout(this.delayedListenTimer)
        this.resetCapture()
        const delayMs = Math.max(0, this.cooldownUntil - Date.now())
        this.delayedListenTimer = setTimeout(() => {
            this.delayedListenTimer = undefined
            if (this.state !== 'idle') return
            this.startListening(source)
        }, delayMs)
        console.log(`[session ${this.sessionId}] listen start delayed ${delayMs}ms (post-TTS cooldown)`)
    }

    private handleJson(msg: Record<string, unknown>): void {
        const type = msg['type'] as string | undefined

        if (type === 'hello') {
            this.version = (msg['version'] as number | undefined) ?? 3
            this.sendJson({
                type: 'hello',
                transport: 'websocket',
                session_id: this.sessionId,
                audio_params: {
                    sample_rate: OUTPUT_SAMPLE_RATE,
                    frame_duration: OUTPUT_FRAME_DURATION_MS,
                },
            })
            console.log(`[session ${this.sessionId}] hello, protocol version=${this.version}`)
            if (BOOT_VOLUME > 0) {
                void this.callRobotToolInternal('self.audio_speaker.set_volume', {
                    volume: BOOT_VOLUME,
                }, { automatic: true, waitForResponse: true }).then(() => {
                    console.log(`[session ${this.sessionId}] boot volume set to ${BOOT_VOLUME}`)
                }).catch(err => {
                    console.warn(`[session ${this.sessionId}] boot volume set failed: ${err instanceof Error ? err.message : String(err)}`)
                })
            }
            return
        }

        if (type === 'listen') {
            const listenState = msg['state'] as string | undefined
            if (listenState === 'start' || listenState === 'detect') {
                const isWakeWordStart = listenState === 'detect'
                const mode = String(msg['mode'] ?? '')
                const source = isWakeWordStart ? `wake_word=${String(msg['text'] ?? '')}` : `mode=${mode}`
                if (!isWakeWordStart) this.lastListenMode = mode
                if (!isWakeWordStart && Date.now() < this.cooldownUntil) {
                    if (this.state === 'listening') {
                        console.log(`[session ${this.sessionId}] listen start already active (${source})`)
                        return
                    }
                    this.delayListeningUntilCooldownEnds(source)
                    return
                }
                this.startListening(source)
            } else if (listenState === 'stop') {
                this.triggerProcess('listen-stop', true)
            }
        }

        if (type === 'abort') {
            this.abort()
            return
        }

        if (type === 'mcp') {
            this.handleMcpPayload(msg['payload'])
        }
    }

    private async process(): Promise<void> {
        const processStartMs = nowMs()
        const frames = this.opusFrames.splice(0)
        const vadPcm = this.pcmChunks.splice(0)
        this.preRollPcmChunks = []
        const source = this.processingSource
        console.log(`[session ${this.sessionId}] processing source=${source} frames=${frames.length} pcmBytes=${vadPcm.reduce((sum, chunk) => sum + chunk.length, 0)}`)
        if (frames.length === 0 && vadPcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-capture')
            return
        }

        // 1. Opus -> PCM -> Hermes STT
        const pcm = vadPcm.length > 0
            ? Buffer.concat(vadPcm)
            : await withTiming(
                `session:${this.sessionId}:audio.decode`,
                async () => this.decodeOpusFramesFn(frames),
                { frames: frames.length },
            )
        if (pcm.length === 0) {
            this.resumeListeningAfterIgnoredInput('empty-pcm')
            return
        }
        if (source === 'max-duration' && vadPcm.length === 0 && MAX_DURATION_STT_RMS_THRESHOLD > 0) {
            const rms = rmsNormalized(pcm)
            if (rms < MAX_DURATION_STT_RMS_THRESHOLD) {
                console.log(`[session ${this.sessionId}] ignored low-rms max-duration audio rms=${rms.toFixed(4)} threshold=${MAX_DURATION_STT_RMS_THRESHOLD.toFixed(4)}`)
                this.resumeListeningAfterIgnoredInput('low-rms-timeout')
                return
            }
        }

        const wavForStt = pcmToWav(pcm, INPUT_SAMPLE_RATE)
        const text = await withTiming(
            `session:${this.sessionId}:stt`,
            () => this.transcribeWavFn(wavForStt),
            { pcmBytes: pcm.length },
        )
        console.log(`[session ${this.sessionId}] STT: "${text}"`)

        if (!text.trim()) {
            this.resumeListeningAfterIgnoredInput('empty-transcript')
            return
        }
        if (isIgnorableShortTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored short transcript: "${text}"`)
            this.resumeListeningAfterIgnoredInput('ignored-short-transcript')
            return
        }
        if (source === 'max-duration' && vadPcm.length === 0 && isIgnorableTimeoutTranscript(text)) {
            console.log(`[session ${this.sessionId}] ignored timeout transcript: "${text}"`)
            this.resumeListeningAfterIgnoredInput('ignored-timeout-transcript')
            return
        }

        this.sendJson({ type: 'stt', text })
        await this.trySpeakFastAck()

        // 2. Hermes LLM turn -> 3. Hermes TTS -> Opus -> device
        await this.speakHermesReply(text, 'llm', 'tts')
        if (this.state === 'processing') this.setAutoLedState('idle')
        console.log(`[timing] done session:${this.sessionId}:process elapsed=${elapsedMs(processStartMs)}`)
    }

    private resumeListeningAfterIgnoredInput(source: string): void {
        if (this.state !== 'processing' || this.closed) return
        this.startListening(source)
    }

    async enqueueFollowup(prompt: string): Promise<void> {
        const cleanPrompt = prompt.trim()
        if (!cleanPrompt || this.closed) return
        this.followupQueue.push(cleanPrompt)
        if (this.state === 'listening') {
            this.clearTimers()
            this.resetCapture()
            this.state = 'idle'
            this.setAutoLedState('idle')
        }
        this.drainFollowupQueue()
    }

    getBridgeStatus(): StackChanBridgeStatus {
        const cooldownRemainingMs = Math.max(0, this.cooldownUntil - Date.now())
        const readyForPrompt =
            !this.closed &&
            this.state === 'listening' &&
            !this.ttsStreaming &&
            cooldownRemainingMs === 0 &&
            !this.followupRunning &&
            this.followupQueue.length === 0 &&
            this.delayedListenTimer === undefined

        let reason = 'ready'
        if (this.closed) reason = 'closed'
        else if (this.state !== 'listening') reason = `state_${this.state}`
        else if (this.ttsStreaming) reason = 'tts_streaming'
        else if (cooldownRemainingMs > 0) reason = 'post_tts_cooldown'
        else if (this.followupRunning) reason = 'followup_running'
        else if (this.followupQueue.length > 0) reason = 'followup_queued'
        else if (this.delayedListenTimer !== undefined) reason = 'listen_delayed'

        return {
            connected: !this.closed,
            sessionId: this.sessionId,
            state: this.state,
            readyForPrompt,
            reason,
            ttsStreaming: this.ttsStreaming,
            cooldownRemainingMs,
            followupRunning: this.followupRunning,
            followupQueued: this.followupQueue.length,
            pendingMcp: this.pendingMcp.size,
            lastListenMode: this.lastListenMode,
        }
    }

    private drainFollowupQueue(): void {
        if (this.closed || this.followupRunning || this.state !== 'idle') return
        const prompt = this.followupQueue.shift()
        if (!prompt) return

        this.followupRunning = true
        this.state = 'processing'
        this.setAutoLedState('thinking')
        this.processFollowup(prompt).catch(async (err) => {
            console.error(`[session ${this.sessionId}] follow-up error:`, err)
            this.setAutoLedState('error')
            this.sendProcessingErrorAlert(err)
            if (this.state === 'processing') {
                await this.speakSegments([PROCESS_ERROR_SPEECH], 'tts.followup.error').catch((error) => {
                    console.error(`[session ${this.sessionId}] follow-up error speech failed:`, error)
                })
                this.sendProcessingErrorAlert(err)
            }
        }).finally(() => {
            this.followupRunning = false
            if (this.state === 'processing') {
                this.state = 'idle'
                this.setAutoLedState('idle')
                if (this.shouldAutoResumeListening()) {
                    if (Date.now() < this.cooldownUntil) {
                        this.delayListeningUntilCooldownEnds('post-followup')
                    } else {
                        this.startListening('post-followup')
                    }
                }
            }
            this.drainFollowupQueue()
        })
    }

    private async processFollowup(prompt: string): Promise<void> {
        const followupStartMs = nowMs()
        console.log(`[session ${this.sessionId}] follow-up prompt queued length=${prompt.length}`)
        await this.speakHermesReply(prompt, 'followup.llm', 'tts.followup')
        console.log(`[timing] done session:${this.sessionId}:followup elapsed=${elapsedMs(followupStartMs)}`)
    }

    private async speakHermesReply(prompt: string, llmLabel: string, ttsLabel: string): Promise<string> {
        const hermesPrompt = stackChanVoicePrompt(prompt)
        if (this.hermes.streamPrompt && readEnvBool('STACKCHAN_STREAM_LLM_TTS', true)) {
            return await this.speakHermesReplyStreaming(hermesPrompt, llmLabel, ttsLabel)
        }
        return await this.speakHermesReplyBuffered(hermesPrompt, llmLabel, ttsLabel)
    }

    private async speakHermesReplyBuffered(prompt: string, llmLabel: string, ttsLabel: string): Promise<string> {
        const processingKeepalive = setInterval(() => {
            if (!TRACKER_ONLY_MODE) this.sendJson({ type: 'llm', emotion: 'doubtful' })
        }, PROCESSING_KEEPALIVE_MS)
        if (!TRACKER_ONLY_MODE) this.sendJson({ type: 'llm', emotion: 'doubtful' })
        let reply: string
        try {
            reply = await withTiming(
                `session:${this.sessionId}:${llmLabel}`,
                () => this.hermes.submitPrompt(prompt),
                { textLength: prompt.length },
            )
        } finally {
            clearInterval(processingKeepalive)
        }
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): "${reply}"`)
        this._emotionTracker.reset()
        this.sendJson({ type: 'llm', emotion: this._emotionTracker.current })
        void this.displayFirstImageFromReply(reply)

        const speechSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig)
        await this.speakSegments(speechSegments, ttsLabel)
        return reply
    }

    private async speakHermesReplyStreaming(prompt: string, llmLabel: string, ttsLabel: string): Promise<string> {
        const streamPrompt = this.hermes.streamPrompt
        if (!streamPrompt) return await this.speakHermesReplyBuffered(prompt, llmLabel, ttsLabel)

        const processingKeepalive = setInterval(() => {
            if (!TRACKER_ONLY_MODE) this.sendJson({ type: 'llm', emotion: 'doubtful' })
        }, PROCESSING_KEEPALIVE_MS)
        if (!TRACKER_ONLY_MODE) this.sendJson({ type: 'llm', emotion: 'doubtful' })

        const llmStartMs = nowMs()
        let reply = ''
        let spokenSegments = 0
        let spokenText = ''
        let playback: TtsPlayback | undefined

        try {
            for await (const event of streamPrompt.call(this.hermes, prompt)) {
                if (event.type === 'delta') {
                    reply += event.text
                } else if (event.type === 'complete' && event.text) {
                    reply = event.text
                }

                if (this.state !== 'processing') break
                const stableSegments = stableSpeechSegmentsFromPartialReply(reply, this.speechSegmentationConfig)
                while (spokenSegments < stableSegments.length && this.state === 'processing') {
                    playback ??= this.startTtsPlayback(ttsLabel)
                    const segText = stableSegments[spokenSegments]
                    await this.speakSegmentInPlayback(
                        playback,
                        segText,
                        `${ttsLabel}.stream.segment${spokenSegments}`,
                        spokenSegments,
                    )
                    spokenText += segText
                    spokenSegments += 1
                    if (playback.interrupted) break
                }
                if (
                    STOP_LLM_AFTER_MAX_SPOKEN_SEGMENTS &&
                    spokenSegments >= this.speechSegmentationConfig.maxSegments
                ) {
                    console.log(`[session ${this.sessionId}] stopping LLM stream after spoken segment limit (${spokenSegments})`)
                    void this.hermes.interrupt().catch((error) => {
                        console.error(`[session ${this.sessionId}] Hermes interrupt after speech limit error:`, error)
                    })
                    break
                }
            }
        } finally {
            clearInterval(processingKeepalive)
        }

        console.log(`[timing] done session:${this.sessionId}:${llmLabel}.stream elapsed=${elapsedMs(llmStartMs)}`)
        console.log(`[session ${this.sessionId}] LLM(${llmLabel}): "${reply}"`)
        this._emotionTracker.reset()
        this.sendJson({ type: 'llm', emotion: this._emotionTracker.current })
        void this.displayFirstImageFromReply(reply)

        const finalSegments = splitStackChanSpeechText(reply, this.speechSegmentationConfig)
        if (!playback) {
            await this.speakSegments(finalSegments, ttsLabel)
            return reply
        }

        try {
            // Compare by content, not by index — streaming stable segments may
            // split differently than the final segments, so slicing by count
            // can drop text. Re-derive remaining segments from the unspoken tail.
            const remainingSegments = computeRemainingSegments(reply, spokenText, finalSegments)
            await this.speakSegmentsInPlayback(playback, remainingSegments, ttsLabel, spokenSegments)
        } finally {
            await this.finishTtsPlayback(playback)
        }
        return reply
    }

    private async synthesizeSegment(speechText: string, label: string, leadSilenceMs = 0): Promise<SynthesizedSegment> {
        const wav = await withTiming(
            `session:${this.sessionId}:${label}.synthesize`,
            () => this.synthesizeTextFn(speechText),
            { textLength: speechText.length },
        )
        if (leadSilenceMs > 0) {
            console.log(`[session ${this.sessionId}] tts preroll ${leadSilenceMs}ms`)
        }
        const opusFrames = await withTiming(
            `session:${this.sessionId}:${label}.encode`,
            async () => this.encodeWavToOpusFramesFn(wav, leadSilenceMs),
            { wavBytes: wav.length, leadSilenceMs },
        )
        return { wav, opusFrames }
    }

    private async warmFastAck(): Promise<void> {
        if (this.fastAckEntries || this.fastAckFailed) return
        try {
            this.fastAckEntries = []
            for (let index = 0; index < FAST_ACK_TEXTS.length; index++) {
                const text = FAST_ACK_TEXTS[index]
                const audio = await this.synthesizeSegment(text, `tts.fast_ack.cache${index}`, TTS_PREROLL_MS)
                this.fastAckEntries.push({ text, wav: audio.wav, frames: audio.opusFrames })
            }
            console.log(`[session ${this.sessionId}] fast ack cached variants=${this.fastAckEntries.length}`)
        } catch (error) {
            this.fastAckFailed = true
            console.warn(`[session ${this.sessionId}] fast ack cache failed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private pickFastAck(): FastAckCacheEntry | undefined {
        if (!this.fastAckEntries || this.fastAckEntries.length === 0) return undefined
        if (this.fastAckEntries.length === 1) return this.fastAckEntries[0]

        let index = Math.floor(Math.random() * this.fastAckEntries.length)
        if (index === this.lastFastAckIndex) {
            index = (index + 1 + Math.floor(Math.random() * (this.fastAckEntries.length - 1))) % this.fastAckEntries.length
        }
        this.lastFastAckIndex = index
        return this.fastAckEntries[index]
    }

    private async trySpeakFastAck(): Promise<void> {
        if (!FAST_ACK_ENABLED || this.fastAckFailed) return
        if (!this.fastAckEntries) {
            void this.warmFastAck()
            return
        }

        const ack = this.pickFastAck()
        if (!ack) return
        const playback = this.startTtsPlayback('tts.fast_ack')
        try {
            console.log(`[session ${this.sessionId}] fast ack selected: "${ack.text}"`)
            await this.speakCachedSegmentInPlayback(playback, ack.text, ack.wav, ack.frames, 0)
        } finally {
            await this.finishTtsPlayback(playback)
        }
    }

    private async speakSegments(segments: string[], label: string): Promise<void> {
        if (segments.length === 0) return
        const playback = this.startTtsPlayback(label)
        try {
            await this.speakSegmentsInPlayback(playback, segments, label, 0)
        } finally {
            await this.finishTtsPlayback(playback)
        }
    }

    private startTtsPlayback(label: string): TtsPlayback {
        const generation = this.ttsGeneration + 1
        this.ttsGeneration = generation
        this.ttsStopSent = false
        this.ttsStreaming = true
        this.ttsStartedAt = Date.now()
        this.resetBargeInDetector()
        this.sendJson({ type: 'tts', state: 'start' })
        this.setAutoLedState('speaking')
        return {
            generation,
            label,
            streamStartMs: nowMs(),
            streamedFrames: 0,
            segmentCount: 0,
            interrupted: false,
            firstFrameLogged: false,
            firstAudibleFrameLogged: false,
            localOutputChecked: false,
            m5SpeakerMutedForLocalOutput: false,
        }
    }

    private isTtsPlaybackActive(playback: TtsPlayback): boolean {
        return this.state === 'processing' && this.ttsGeneration === playback.generation
    }

    private prefetchSegment(segment: string, label: string, index: number): PrefetchedSegment {
        const promise = this.synthesizeSegment(segment, `${label}.segment${index}`)
        promise.catch(() => undefined)
        return { index, promise }
    }

    private async speakSegmentsInPlayback(
        playback: TtsPlayback,
        segments: string[],
        label: string,
        startIndex: number,
    ): Promise<void> {
        let prefetched: PrefetchedSegment | undefined
        try {
            for (let offset = 0; offset < segments.length; offset++) {
                const index = startIndex + offset
                if (!this.isTtsPlaybackActive(playback)) {
                    playback.interrupted = true
                    break
                }

                const segment = segments[offset]
                const framesPromise = prefetched?.index === index ? prefetched.promise : undefined
                prefetched = undefined
                const nextSegment = segments[offset + 1]
                await this.speakSegmentInPlayback(
                    playback,
                    segment,
                    `${label}.segment${index}`,
                    index,
                    framesPromise,
                    () => {
                        if (nextSegment && this.isTtsPlaybackActive(playback)) {
                            prefetched = this.prefetchSegment(nextSegment, label, index + 1)
                        }
                    },
                )
                if (playback.interrupted) break
            }
        } finally {
            prefetched?.promise.catch(() => undefined)
        }
    }

    private async speakSegmentInPlayback(
        playback: TtsPlayback,
        segment: string,
        label: string,
        index: number,
        framesPromise?: Promise<SynthesizedSegment>,
        onFramesReady?: () => void,
    ): Promise<void> {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }

        // StackChan v10.9.7 + 26/08 08:24 + 10:31: emoción POR FRASE con tracker
        // (señal fuerte = cambio inmediato, débil repetida = cambio, neutra =
        // vuelta a la cara base neutral). La cara arranca en ojos abiertos.
        // StackChan v10.13 (26/08/2026): corazón en momentos de amor (siempre) y
        // en contento (a veces, con probabilidad y cooldown).
        const emotion = this._emotionTracker.update(segment)
        this.sendJson({ type: 'llm', emotion })
        this.maybeShowHeart(segment, emotion)
        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index })
        await this.prepareLocalTtsOutput(playback)
        const leadSilenceMs = playback.localOutputTarget
            ? 0
            : (index === 0 && playback.streamedFrames === 0 ? TTS_PREROLL_MS : 0)
        const audio = framesPromise ? await framesPromise : await this.synthesizeSegment(segment, label, leadSilenceMs)
        onFramesReady?.()
        const localPlayback = this.startLocalSegmentPlayback(playback, audio.wav)
        const leadSilenceFrames = Math.ceil(leadSilenceMs / OUTPUT_FRAME_DURATION_MS)
        for (let frameIndex = 0; frameIndex < audio.opusFrames.length; frameIndex++) {
            const frame = audio.opusFrames[frameIndex]
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true
                break
            }
            this.sendBinary(wrapOpusPayload(frame, this.version))
            playback.streamedFrames += 1
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames)
            // Pre-buffer: los primeros TTS_PRE_BUFFER_FRAMES sin esperar (llenan la cola del firmware)
            if (frameIndex >= TTS_PRE_BUFFER_FRAMES) {
                await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
            }
        }
        await localPlayback
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        playback.segmentCount += 1
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index })
    }

    private async speakCachedSegmentInPlayback(
        playback: TtsPlayback,
        segment: string,
        wav: Buffer,
        opusFrames: Buffer[],
        index: number,
    ): Promise<void> {
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }

        // StackChan v10.9.7 + 26/08 08:24 + 10:31: emoción POR FRASE también en
        // segmentos cacheados, con el mismo tracker (vuelta a neutral al
        // acabar la señal).
        // StackChan v10.13 (26/08/2026): corazón en momentos de amor (siempre) y
        // en contento (a veces, con probabilidad y cooldown).
        const emotion = this._emotionTracker.update(segment)
        this.sendJson({ type: 'llm', emotion })
        this.maybeShowHeart(segment, emotion)
        this.sendJson({ type: 'tts', state: 'sentence_start', text: segment, index })
        await this.prepareLocalTtsOutput(playback)
        const localPlayback = this.startLocalSegmentPlayback(playback, wav)
        const leadSilenceFrames = !playback.localOutputTarget && index === 0 && playback.streamedFrames === 0
            ? Math.ceil(TTS_PREROLL_MS / OUTPUT_FRAME_DURATION_MS)
            : 0
        for (let frameIndex = 0; frameIndex < opusFrames.length; frameIndex++) {
            const frame = opusFrames[frameIndex]
            if (!this.isTtsPlaybackActive(playback)) {
                playback.interrupted = true
                break
            }
            this.sendBinary(wrapOpusPayload(frame, this.version))
            playback.streamedFrames += 1
            this.logTtsFrameMilestones(playback, frameIndex >= leadSilenceFrames)
            // Pre-buffer: los primeros TTS_PRE_BUFFER_FRAMES sin esperar (llenan la cola del firmware)
            if (frameIndex >= TTS_PRE_BUFFER_FRAMES) {
                await new Promise(resolve => setTimeout(resolve, OUTPUT_FRAME_DURATION_MS))
            }
        }
        await localPlayback
        if (!this.isTtsPlaybackActive(playback)) {
            playback.interrupted = true
            return
        }
        playback.segmentCount += 1
        this.sendJson({ type: 'tts', state: 'sentence_end', text: segment, index })
    }

    private async prepareLocalTtsOutput(playback: TtsPlayback): Promise<void> {
        if (playback.localOutputChecked) return
        playback.localOutputChecked = true
        if (!this.localTtsOutputConfig.enabled) return

        try {
            const target = await resolveLocalTtsOutputTarget(this.localTtsOutputConfig)
            if (!target) {
                console.log(`[session ${this.sessionId}] local TTS output unavailable; using M5 speaker`)
                return
            }
            await this.callRobotToolInternal('self.audio_speaker.set_volume', {
                volume: 0,
                permanent: false,
            }, { automatic: true, waitForResponse: true })
            playback.localOutputTarget = target
            playback.m5SpeakerMutedForLocalOutput = true
            console.log(`[session ${this.sessionId}] local TTS output active target=${target}; M5 speaker muted temporarily`)
        } catch (error) {
            console.warn(`[session ${this.sessionId}] local TTS output setup failed; using M5 speaker: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private startLocalSegmentPlayback(playback: TtsPlayback, wav: Buffer): Promise<void> {
        const target = playback.localOutputTarget
        if (!target) return Promise.resolve()
        return playWavOnLocalTarget(target, wav).catch(async (error) => {
            console.warn(`[session ${this.sessionId}] local TTS playback failed; restoring M5 speaker: ${error instanceof Error ? error.message : String(error)}`)
            playback.localOutputTarget = undefined
            await this.restoreM5SpeakerAfterLocalOutput(playback)
        })
    }

    private async restoreM5SpeakerAfterLocalOutput(playback: TtsPlayback): Promise<void> {
        if (!playback.m5SpeakerMutedForLocalOutput) return
        playback.m5SpeakerMutedForLocalOutput = false
        try {
            await this.callRobotToolInternal('self.audio_speaker.set_volume', {
                volume: this.localTtsOutputConfig.fallbackM5Volume,
                permanent: false,
            }, { automatic: true, waitForResponse: true })
            console.log(`[session ${this.sessionId}] M5 speaker restored volume=${this.localTtsOutputConfig.fallbackM5Volume}`)
        } catch (error) {
            console.error(`[session ${this.sessionId}] failed to restore M5 speaker after local TTS:`, error)
        }
    }

    private logTtsFrameMilestones(playback: TtsPlayback, audibleFrame: boolean): void {
        if (!playback.firstFrameLogged) {
            playback.firstFrameLogged = true
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_frame_sent elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames}`)
        }
        if (audibleFrame && !playback.firstAudibleFrameLogged) {
            playback.firstAudibleFrameLogged = true
            console.log(`[timing] mark session:${this.sessionId}:${playback.label}.first_audible_frame_sent elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames}`)
        }
    }

    private async finishTtsPlayback(playback: TtsPlayback): Promise<void> {
        this.sendTtsStopOnce(playback.generation)
        if (this.ttsGeneration === playback.generation) {
            this.ttsStreaming = false
            this.resetBargeInDetector()
        }
        console.log(`[timing] done session:${this.sessionId}:${playback.label}.stream elapsed=${elapsedMs(playback.streamStartMs)} frames=${playback.streamedFrames} segments=${playback.segmentCount}`)

        if (!playback.interrupted && this.state === 'processing' && this.ttsGeneration === playback.generation) {
            // TTS 再生後のエコー誤検知を防ぐためクールダウンを設定
            this.cooldownUntil = Date.now() + this.postTtsCooldownMs
        }
        await this.restoreM5SpeakerAfterLocalOutput(playback)
    }

    private sendTtsStopOnce(generation: number): void {
        if (!this.ttsStreaming && this.ttsGeneration === generation) return
        if (this.ttsGeneration !== generation) return
        if (this.ttsStopSent) return
        this.ttsStopSent = true
        this.sendJson({ type: 'tts', state: 'stop' })
    }

    private async displayFirstImageFromReply(reply: string): Promise<void> {
        const source = extractFirstDisplayImage(reply)
        if (!source) return

        try {
            const url = resolveDisplayImageSource(source)
            if (!url) return
            await this.callRobotTool('self.screen.preview_image_url', {
                url,
                duration_seconds: 6,
            })
        } catch (error) {
            console.error(`[session ${this.sessionId}] display image error:`, error)
        }
    }

    async callRobotTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        return await this.callRobotToolInternal(name, args, { automatic: false, waitForResponse: true })
    }

    private async callRobotToolInternal(
        name: string,
        args: Record<string, unknown>,
        options: { automatic: boolean; waitForResponse: boolean },
    ): Promise<unknown> {
        if (name === 'self.robot.set_led_color' && !options.automatic) {
            this.manualLedHoldUntil = Date.now() + this.autoLedConfig.manualHoldMs
        }

        const id = this.nextMcpId++
        // StackChan v10.9.7: el flag automatic viaja en los args para que el firmware
        // aplique estilo IA china (1 LED lateral, sin persistir) vs manual (persiste).
        const toolArgs = name === 'self.robot.set_led_color'
            ? { ...args, automatic: options.automatic }
            : args
        const payload = {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: toolArgs },
        }

        if (!options.waitForResponse) {
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload })
            return undefined
        }

        return await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingMcp.delete(id)
                reject(new Error(`StackChan robot tool timed out: ${name}`))
            }, MCP_REQUEST_TIMEOUT_MS)
            this.pendingMcp.set(id, { resolve, reject, timer })
            this.sendJson({ type: 'mcp', session_id: this.sessionId, payload })
        })
    }

    private setAutoLedState(state: AutoLedState): void {
        if (!this.autoLedConfig.enabled) return
        if (Date.now() < this.manualLedHoldUntil) return
        if (this.lastAutoLedState === state) return
        this.lastAutoLedState = state

        const colors: Record<AutoLedState, { red: number; green: number; blue: number }> = {
            listening: { red: 0, green: 32, blue: 0 },
            thinking: { red: 32, green: 24, blue: 0 },
            speaking: { red: 0, green: 0, blue: 40 },
            idle: { red: 0, green: 0, blue: 0 },
            error: { red: 48, green: 0, blue: 0 },
        }

        void this.callRobotToolInternal('self.robot.set_led_color', colors[state], {
            automatic: true,
            waitForResponse: false,
        }).catch((error) => {
            console.error(`[session ${this.sessionId}] auto LED error:`, error)
        })
    }

    // StackChan v10.13 (26/08/2026): decoración de corazón en la carita.
    // - Amor (LOVE_EXPRESSION_RE): siempre que aparezca, con cooldown global.
    // - Contento (happy): a veces (probabilidad) para no saturar el efecto.
    private _lastHeartAt = 0
    private static readonly HEART_MIN_INTERVAL_MS = 10_000
    private static readonly HEART_HAPPY_PROBABILITY = 0.35

    private maybeShowHeart(segment: string, emotion: StackChanEmotion): void {
        const now = Date.now()
        if (now - this._lastHeartAt < Session.HEART_MIN_INTERVAL_MS) return
        const isLove = LOVE_EXPRESSION_RE.test(segment)
        const isHappyMoment = emotion === 'happy' && Math.random() < Session.HEART_HAPPY_PROBABILITY
        if (!isLove && !isHappyMoment) return
        this._lastHeartAt = now
        void this.callRobotToolInternal(
            'self.display.show_heart',
            { duration_ms: 2500 },
            { automatic: true, waitForResponse: false },
        ).catch((error) => {
            console.error(`[session ${this.sessionId}] show_heart error:`, error)
        })
    }

    private handleMcpPayload(payload: unknown): void {
        if (!isRecord(payload) || typeof payload['id'] !== 'number') return
        const pending = this.pendingMcp.get(payload['id'])
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingMcp.delete(payload['id'])
        if (isRecord(payload['error'])) {
            pending.reject(new Error(String(payload['error']['message'] ?? 'StackChan robot tool failed')))
            return
        }
        pending.resolve(payload['result'])
    }

    private sendProcessingErrorAlert(error: unknown): void {
        this.sendJson({
            type: 'alert',
            status: 'HERMES AI ERROR',
            message: buildProcessingErrorAlertMessage(error),
            emotion: 'sad',
        })
    }

    private sendJson(obj: Record<string, unknown>): void {
        try {
            this.ws.send(JSON.stringify(obj))
        } catch {
            // 切断済みの場合は無視
        }
    }

    private sendBinary(data: Buffer): void {
        try {
            this.ws.send(data)
        } catch {
            // 切断済みの場合は無視
        }
    }
}
