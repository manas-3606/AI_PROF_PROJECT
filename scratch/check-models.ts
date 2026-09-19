import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';

function getApiKey(): string {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your-gemini-api-key-here') {
    return process.env.GEMINI_API_KEY.trim();
  }
  const envContent = fs.readFileSync('.env', 'utf-8');
  const m = envContent.match(/GEMINI_API_KEY=["']?([^"'\r\n]+)/);
  return m ? m[1].trim() : '';
}

async function main() {
  const apiKey = getApiKey();
  console.log('API Key length:', apiKey.length);
  const ai = new GoogleGenAI({ apiKey });

  try {
    console.log('\n--- FETCHING MODEL LIST FROM GEMINI API ---');
    const modelList = await ai.models.list();
    console.log('Available models:');
    for await (const m of modelList) {
      if (m.name?.includes('gemini') || m.name?.includes('flash')) {
        console.log(`- Name: ${m.name} | Display: ${m.displayName} | Version: ${m.version}`);
      }
    }
  } catch (err: any) {
    console.error('Error listing models:', err.message || err);
  }

  // Test calling gemini-2.5-flash vs gemini-2.0-flash vs gemini-1.5-flash
  const candidateModels = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
  ];

  for (const model of candidateModels) {
    try {
      console.log(`\nTesting generateContent with model: "${model}"...`);
      const start = Date.now();
      const res = await ai.models.generateContent({
        model,
        contents: 'Respond with exactly: {"status":"ok","model":"' + model + '"} in valid JSON format.',
        config: {
          responseMimeType: 'application/json',
        },
      });
      const elapsed = Date.now() - start;
      console.log(`>>> [SUCCESS] Model "${model}" responded in ${elapsed}ms:`, res.text?.trim());
      console.log('Response metadata keys:', Object.keys(res));
      console.log('ModelVersion from response:', (res as any).modelVersion);
    } catch (err: any) {
      console.error(`>>> [FAILED] Model "${model}":`, err.message || err);
    }
  }
}

main().catch(console.error);
