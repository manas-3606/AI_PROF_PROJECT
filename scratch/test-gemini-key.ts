import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

const envPath = 'c:\\Users\\Manasa\\Desktop\\AI_PROF_PROJECT\\.env';
const envContent = fs.readFileSync(envPath, 'utf-8');
const match = envContent.match(/GEMINI_API_KEY=["']?([^"'\r\n]+)/);
const apiKey = match ? match[1].trim() : process.env.GEMINI_API_KEY;

console.log('API Key loaded. Length:', apiKey?.length, 'Prefix:', apiKey?.slice(0, 8));

async function main() {
  const ai = new GoogleGenAI({ apiKey });
  const testPrompts = [
    'Can you tell me where Metropolitan Health System is located?',
    'Please book the next available slot on Tuesday.',
    'I need to reschedule this appointment due to a work conflict.',
  ];

  for (const prompt of testPrompts) {
    const start = Date.now();
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: `You are an AI hospital dialogue router. Analyze the user utterance: "${prompt}". Output JSON: {"intent": string, "entities": object, "confidence": "HIGH"|"MEDIUM"|"LOW"}`,
      config: { responseMimeType: 'application/json' },
    });
    const elapsed = Date.now() - start;
    console.log(`[PROMPT]: "${prompt}" -> Latency: ${elapsed}ms`);
    console.log('Result:', res.text?.trim());
  }
}

main().catch(err => {
  console.error('Error calling Gemini:', err);
});
