import { Router } from 'express';
const PROVIDER_KEYS = [
    { id: 'openrouter', label: 'OpenRouter', envKey: 'OPENROUTER_API_KEY' },
    { id: 'groq', label: 'Groq', envKey: 'GROQ_API_KEY' },
    { id: 'mistral', label: 'Mistral AI', envKey: 'MISTRAL_API_KEY' },
    { id: 'cerebras', label: 'Cerebras', envKey: 'CEREBRAS_API_KEY' },
    { id: 'kilo', label: 'Kilo Gateway', envKey: 'KILO_API_KEY' },
    { id: 'nvidia_nim', label: 'Nvidia NIM', envKey: 'NVIDIA_API_KEY' },
    { id: 'opencode', label: 'OpenCode', envKey: 'OPENCODE_API_KEY' },
    { id: 'ollama', label: 'Ollama', envKey: 'OLLAMA_API_KEY' },
];
export function createSettingsRouter({ config }) {
    const router = Router();
    router.get('/model-credentials', (req, res) => {
        const creds = PROVIDER_KEYS.map((p) => ({
            ...p,
            configured: !!(process.env[p.envKey] || config.omniroute?.providerKeys?.[p.id]),
        }));
        res.json(creds);
    });
    return router;
}
