import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { registerDeviceAuthRoutes } from './server/deviceAuth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerVoiceProfile {
  voiceName: 'Charon' | 'Puck' | 'Kore' | 'Zephyr' | 'Fenrir';
  style: string;
}

const VOICE_PROFILE_MAP: Record<string, ServerVoiceProfile> = {
  'en-prof-male': {
    voiceName: 'Charon',
    style:
      'Clear, polished, warm professional male conference announcer speaking naturally in English.',
  },
  'en-friendly-male': {
    voiceName: 'Puck',
    style:
      'Upbeat, welcoming, friendly male workshop host speaking enthusiastically in English.',
  },
  'en-prof-female': {
    voiceName: 'Kore',
    style:
      'Clear, poised, professional female conference announcer speaking naturally in English.',
  },
  'en-friendly-female': {
    voiceName: 'Zephyr',
    style:
      'Warm, cheerful, inviting female workshop host speaking naturally in English.',
  },
  'id-male': {
    voiceName: 'Fenrir',
    style:
      'Speak in clear, natural, warm standard Indonesian (Bahasa Indonesia) as a polite male event host.',
  },
  'id-female': {
    voiceName: 'Kore',
    style:
      'Speak in clear, natural, warm standard Indonesian (Bahasa Indonesia) as a welcoming female event host.',
  },
};

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    res.json({
      ok: true,
      ttsAvailable: Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY'),
    });
  });

  registerDeviceAuthRoutes(app);

  app.post('/api/tts', async (req, res) => {
    const body = (req.body ?? {}) as {
      text?: unknown;
      voiceId?: unknown;
      language?: unknown;
    };

    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    if (!rawText || rawText.length > 500) {
      res.status(400).json({
        error: 'Announcement text must be between 1 and 500 characters.',
      });
      return;
    }

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'AI Text-to-Speech service is not configured on this server.',
      });
      return;
    }

    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : 'en-prof-female';
    const language = body.language === 'id-ID' ? 'id-ID' : 'en-US';
    const fallbackId = language === 'id-ID' ? 'id-female' : 'en-prof-female';
    const profile = VOICE_PROFILE_MAP[voiceId] ?? VOICE_PROFILE_MAP[fallbackId];

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: rawText,
                speechMetadata: {
                  style: profile.style,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: profile.voiceName,
              },
            },
          },
        },
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({
          error: 'No audio was returned from the AI Text-to-Speech model.',
        });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
        voiceName: profile.voiceName,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'AI Text-to-Speech request failed.';
      console.error('Gemini TTS error:', message);
      res.status(500).json({ error: message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`PRESENZA server listening on http://0.0.0.0:${port}`);
  });
}

void startServer();
