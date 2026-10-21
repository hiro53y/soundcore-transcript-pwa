import { buildApp } from './app.js';
import { assertStartable, loadConfig } from './config.js';
import { log } from './log.js';
import { MockLlmProvider, MockTranscriptionProvider } from './providers/mock.js';
import { OpenAILlmProvider, OpenAITranscriptionProvider } from './providers/openai.js';

const cfg = loadConfig();
assertStartable(cfg);

const mock = cfg.provider === 'mock';
const { app } = await buildApp({
  cfg,
  transcription: mock ? new MockTranscriptionProvider(300) : new OpenAITranscriptionProvider(cfg),
  llm: mock ? new MockLlmProvider() : new OpenAILlmProvider(cfg),
});

if (!mock && !cfg.openaiApiKey) log('warn.no_api_key');
await app.listen({ port: cfg.port, host: cfg.host });
log('server.started', { port: cfg.port, provider: cfg.provider });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)));
}
