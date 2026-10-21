import type { Settings } from '../types';
import { geminiTextEngine, geminiTranscribeEngine } from './gemini';
import { defaultLocalDeps, localTranscribeEngine } from './local';
import { rulesTextEngine } from './rules';
import { serverTextEngine, serverTranscribeEngine } from './server';
import type { TextEngine, TranscribeEngine } from './types';

export function getTranscribeEngine(s: Pick<Settings, 'transcribeEngine' | 'geminiApiKey' | 'geminiModel' | 'whisperModel' | 'whisperGpu'>): TranscribeEngine {
  switch (s.transcribeEngine) {
    case 'gemini':
      return geminiTranscribeEngine({ apiKey: s.geminiApiKey, model: s.geminiModel });
    case 'server':
      return serverTranscribeEngine;
    default:
      return localTranscribeEngine(s.whisperModel, defaultLocalDeps(s.whisperGpu));
  }
}

export function getTextEngine(s: Pick<Settings, 'textEngine' | 'geminiApiKey' | 'geminiModel'>): TextEngine {
  switch (s.textEngine) {
    case 'gemini':
      return geminiTextEngine({ apiKey: s.geminiApiKey, model: s.geminiModel });
    case 'server':
      return serverTextEngine;
    default:
      return rulesTextEngine;
  }
}
