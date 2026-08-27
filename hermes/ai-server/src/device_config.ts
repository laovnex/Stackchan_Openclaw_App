// device_config.ts — Per-device backend binding
// Reads devices.json and provides lookup by Device-Id (MAC address)
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Avoid import.meta.url (requires ES2020+ module setting)
// Use process.cwd() relative resolution instead

export type Backend = 'openclaw' | 'hermes'

export interface DeviceBinding {
    backend: Backend
    agent_id: string
    label?: string
}

export interface DeviceConfig {
    default: DeviceBinding
    devices: Record<string, DeviceBinding>
}

let cachedConfig: DeviceConfig | null = null

function loadConfig(): DeviceConfig {
    if (cachedConfig) return cachedConfig
    
    // Try multiple locations: CWD, ai-server/, and relative to this file
    const candidates = [
        resolve(process.cwd(), 'devices.json'),
        resolve(process.cwd(), 'ai-server', 'devices.json'),
    ]
    const configPath = candidates.find(p => { try { readFileSync(p, 'utf-8'); return true } catch { return false } }) ?? candidates[0]
    try {
        const raw = readFileSync(configPath, 'utf-8')
        cachedConfig = JSON.parse(raw) as DeviceConfig
    } catch {
        // Fallback: default to OpenClaw + your-agent
        cachedConfig = {
            default: { backend: 'openclaw' as Backend, agent_id: 'your-agent' },
            devices: {}
        }
    }
    return cachedConfig
}

export function getDeviceBinding(deviceId: string | undefined): DeviceBinding {
    const config = loadConfig()
    
    if (deviceId && config.devices[deviceId]) {
        return config.devices[deviceId]
    }
    
    return config.default
}

// Hot-reload config (for when devices.json is edited without restart)
export function reloadConfig(): void {
    cachedConfig = null
    loadConfig()
}

// Agent token -> agent_id mapping (firmware app_openclaw.cpp kAgents[])
// The firmware sends the selected agent's token in the WS Authorization header
// (Bearer <token>). This lets the robot buttons route to the right OpenClaw agent.
const AGENT_TOKEN_MAP: Record<string, string> = {
    '00000000000000000000000000000001': 'agent-main',
    '00000000000000000000000000000002': 'agent-2',
    '00000000000000000000000000000003': 'agent-3',
    '00000000000000000000000000000004': 'agent-4',
    '00000000000000000000000000000005': 'agent-5',
}

export function getAgentBindingFromToken(token: string | undefined): DeviceBinding | undefined {
    if (!token) return undefined
    const agentId = AGENT_TOKEN_MAP[token]
    if (!agentId) return undefined
    return { backend: 'openclaw' as Backend, agent_id: agentId }
}

// NOTE: agent_id is currently only used by the OpenClaw backend.
// HermesClient connects to a global HERMES_DASHBOARD_URL and does not
// support per-device agent routing. The agent_id field in devices.json
// is ignored for Hermes-bound devices (documented limitation).