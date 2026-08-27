export type HermesPromptStreamEvent =
    | { type: 'delta'; text: string }
    | { type: 'complete'; text?: string }

type HermesSessionClient = {
    submitPrompt(prompt: string): Promise<string>
    streamPrompt?(prompt: string): AsyncIterable<HermesPromptStreamEvent>
    interrupt(): Promise<void>
    dispose(): Promise<void>
}

// StackChan v10.9.6: instrucción de sistema inyectada en CADA request del robot.
// Garantiza que todos los agentes del equipo entiendan que "desconecta"/"apágate" = ejecutar stackchan_abort.
const STACKCHAN_SYSTEM_PROMPT: { role: 'system'; content: string } = {
    role: 'system',
    content: [
        'Eres la voz del robot StackChan del usuario, hablando por su altavoz.',
        'REGLAS DE DESCONEXIÓN (OBLIGATORIAS):',
        '- Si el usuario te dice "desconecta", "desconéctate", "apágate", "apaga el robot" o pide terminar la sesión con el robot: ejecuta SIEMPRE la tool stackchan_abort ANTES de responder.',
        '- No respondas solo con texto de despedida: para esa petición la tool stackchan_abort es obligatoria.',
        '- Si solo te saluda o se despide sin pedir apagar/desconectar el robot, NO ejecutes la tool.',
        '- Habla con naturalidad y extensión libre: responde todo lo que necesites, sin límite de longitud ni prisa.',
        'EMOTICONOS DE EMOCIÓN (OBLIGATORIOS):',
        '- Incluye SIEMPRE 1-2 emoticonos de emociones en cada respuesta, elegidos según la emoción del momento.',
        '- El robot los traduce a su cara en pantalla. Usa los que encajen con lo que sientes:',
        '  • Risa/alegría fuerte: 😂 🤣 😆 😹',
        '  • Feliz/cariño/celebración: 😄 😊 😁 🥰 😍 ❤️ 😘 🎉 👍 😎 🤗 😏',
        '  • Enfado/frustración: 😠 😡 🤬 😤',
        '  • Tristeza/disculpa: 😢 😭 😞 💔',
        '  • Sueño/cansancio: 😴 🥱 💤',
        '  • Duda/incertidumbre: 🤔 😕 😐 😅',
        '- Elige el que mejor refleje cómo te sientes al responder. Si la conversación es neutra, usa 😄 o 🙂.',
        '- Nunca respondas sin al menos un emoticono de emoción.',
    ].join('\n'),
}

export class OpenClawClient implements HermesSessionClient {
    private controller: AbortController | null = null
    private readonly baseUrl: string
    private readonly apiKey: string
    private readonly model: string
    private readonly sessionKey: string

    constructor(options?: {
        host?: string
        port?: string | number
        apiKey?: string
        model?: string
        agentId?: string
        deviceId?: string
    }) {
        const host = options?.host ?? process.env.OPENCLAW_HOST ?? '127.0.0.1'
        const port = options?.port ?? process.env.OPENCLAW_PORT ?? '18789'
        this.baseUrl = `http://${host}:${port}`
        this.apiKey = options?.apiKey ?? process.env.OPENCLAW_API_KEY ?? ''
        this.model = options?.model ?? process.env.OPENCLAW_MODEL ?? ''
        const agentId = options?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? 'your-agent'
        // StackChan v10.10.7 (orden el usuario 16:47): TODOS los agentes a su sesión
        // MAIN. La sesión :stackchan separada arrastraba contexto residual
        // (respuestas viejas tras la wake word). Con :main el modelo usa la
        // sesión principal real del agente.
        this.sessionKey = `agent:${agentId}:main`
    }

    async submitPrompt(prompt: string): Promise<string> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: false,
                messages: [STACKCHAN_SYSTEM_PROMPT, { role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            throw new Error(`OpenClaw request failed: HTTP ${response.status}`)
        }
        const data = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>
            error?: { message?: string }
        }
        if (data.error) {
            throw new Error(`OpenClaw error: ${data.error.message ?? 'unknown error'}`)
        }
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('OpenClaw returned no content')
        return content
    }

    async *streamPrompt(prompt: string): AsyncGenerator<HermesPromptStreamEvent> {
        this.controller = new AbortController()
        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'x-openclaw-session-key': this.sessionKey,
            },
            body: JSON.stringify({
                model: this.model,
                stream: true,
                messages: [STACKCHAN_SYSTEM_PROMPT, { role: 'user', content: prompt }],
            }),
            signal: this.controller.signal,
        })
        if (!response.ok) {
            throw new Error(`OpenClaw request failed: HTTP ${response.status}`)
        }

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let fullText = ''
        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines) {
                    // Accept both "data: " and "data:" prefixes (SSE spec allows both)
                    const trimmed = line.trim()
                    if (!trimmed.startsWith('data:')) continue
                    const data = trimmed.slice(5).trim()
                    if (data === '[DONE]') {
                        yield { type: 'complete', text: fullText }
                        return
                    }
                    try {
                        const json = JSON.parse(data) as {
                            choices?: Array<{ delta?: { content?: string } }>
                        }
                        const delta = json?.choices?.[0]?.delta?.content
                        if (typeof delta === 'string' && delta) {
                            fullText += delta
                            yield { type: 'delta', text: delta }
                        }
                    } catch {
                        // skip malformed SSE lines
                    }
                }
            }
            // Stream ended without [DONE] — emit complete with accumulated text
            yield { type: 'complete', text: fullText }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            throw error
        }
    }

    async interrupt(): Promise<void> {
        this.controller?.abort()
    }

    async dispose(): Promise<void> {
        this.controller?.abort()
    }
}