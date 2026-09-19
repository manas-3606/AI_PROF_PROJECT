import fs from 'fs';
import path from 'path';

function walk(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file === 'build' || file === 'scratch' || file === '.gemini') continue;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walk(filePath, fileList);
    } else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.env')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allFiles = walk(process.cwd());

// 1. Gather all process.env variables
const envVars = new Set<string>();
const envUsageRegex = /process\.env\.([A-Z0-9_]+)/g;

for (const file of allFiles) {
  if (file.includes('tests') || file.includes('scratch')) continue;
  const content = fs.readFileSync(file, 'utf-8');
  let match;
  while ((match = envUsageRegex.exec(content)) !== null) {
    envVars.add(match[1]);
  }
}

console.log('All process.env variables referenced in source code:');
console.log(Array.from(envVars).sort());

// Read .env.example
const envExamplePath = path.join(process.cwd(), '.env.example');
const envExampleContent = fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf-8') : '';
const exampleVars = new Set<string>();
for (const line of envExampleContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const key = trimmed.split('=')[0].trim();
    if (key) exampleVars.add(key);
  }
}

console.log('\nVariables in .env.example:');
console.log(Array.from(exampleVars).sort());

const missingInExample = Array.from(envVars).filter(v => !exampleVars.has(v) && v !== 'NODE_ENV' && v !== 'PORT');
console.log('\nReferenced env vars missing from .env.example:', missingInExample);

// 2. Check for hardcoded secret assignments in src/
const hardcodedSuspicious: { file: string; line: number; match: string }[] = [];
const secretPattern = /(?:api_?key|jwt_?secret|private_?key)\s*[:=]\s*['"`]([A-Za-z0-9_\-\.]{15,})['"`]/i;

for (const file of allFiles) {
  if (file.includes('tests') || file.includes('seed') || file.includes('scratch') || file.endsWith('.env.example')) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, idx) => {
    if (secretPattern.test(line)) {
      hardcodedSuspicious.push({ file: path.relative(process.cwd(), file), line: idx + 1, match: line.trim() });
    }
  });
}

console.log('\nSuspicious hardcoded secrets in source files:');
console.log(hardcodedSuspicious);
