import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '10mb' }));

let _ai = null;
function getAI() {
  if (!_ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('GEMINI_API_KEY is not set in server environment.');
    }
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

app.post('/api/gemini/generate', async (req, res) => {
  try {
    const { model, contents, config } = req.body;
    if (!model || !contents) {
      return res.status(400).json({ error: 'model and contents are required' });
    }
    const ai = getAI();
    const response = await ai.models.generateContent({ model, contents, config });
    res.json({ text: response.text || '' });
  } catch (err) {
    console.error('Gemini proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// In production, serve the built Vite app
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('{*path}', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Komi server listening on port ${PORT}`);
});
