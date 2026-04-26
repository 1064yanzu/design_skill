#!/usr/bin/env node
/**
 * Generate TTS audio with multiple providers.
 *
 * Usage:
 *   node generate-tts.js --config=docs/examples/mimo-tts.config.example.json
 *
 * Supported providers:
 *   - xiaomi-mimo
 *   - geekai-audio-speech
 *   - newapi-audio-speech
 *   - openai-audio-speech
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveFromBase(baseDir, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath);
}

function readTextMaybeInline(config, inlineKey, fileKey, baseDir) {
  if (typeof config[inlineKey] === 'string' && config[inlineKey].trim()) {
    return config[inlineKey].trim();
  }
  if (typeof config[fileKey] === 'string' && config[fileKey].trim()) {
    return fs.readFileSync(resolveFromBase(baseDir, config[fileKey]), 'utf8').trim();
  }
  return '';
}

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  throw new Error(`Unsupported voice sample format: ${filePath}. Only .mp3 and .wav are supported.`);
}

function loadVoiceSampleDataUri(filePath, baseDir) {
  const absolutePath = resolveFromBase(baseDir, filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Voice sample file not found: ${absolutePath}`);
  }
  const mimeType = detectMimeType(absolutePath);
  const base64Audio = fs.readFileSync(absolutePath).toString('base64');
  return `data:${mimeType};base64,${base64Audio}`;
}

function requestJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
      });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`TTS request failed (${response.statusCode}): ${raw}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Failed to parse JSON response: ${error.message}`));
        }
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function requestBinary(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => {
        chunks.push(chunk);
      });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`TTS request failed (${response.statusCode}): ${buffer.toString('utf8')}`));
          return;
        }
        resolve(buffer);
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function usageAndExit() {
  console.error('Usage: node generate-tts.js --config=<path-to-config.json>');
  process.exit(1);
}

function requireField(value, message) {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function resolveBaseUrl(config, envKey, defaultValue) {
  if (typeof config.apiBaseUrl === 'string' && config.apiBaseUrl.trim()) {
    return config.apiBaseUrl.trim();
  }
  if (envKey && process.env[envKey] && process.env[envKey].trim()) {
    return process.env[envKey].trim();
  }
  if (defaultValue) {
    return defaultValue;
  }
  throw new Error(`Missing apiBaseUrl. Set config.apiBaseUrl or environment variable ${envKey}.`);
}

function joinUrl(baseUrl, resourcePath) {
  return `${baseUrl.replace(/\/$/, '')}${resourcePath}`;
}

function getProviderSettings(config) {
  switch (config.provider) {
    case 'xiaomi-mimo':
      return {
        apiBaseUrl: resolveBaseUrl(config, 'MIMO_API_BASE_URL', 'https://api.xiaomimimo.com/v1'),
        apiKeyEnv: config.apiKeyEnv || 'MIMO_API_KEY',
        path: '/chat/completions',
        authHeaders: apiKey => ({ 'api-key': apiKey }),
        responseMode: 'json-base64',
      };
    case 'geekai-audio-speech':
      return {
        apiBaseUrl: resolveBaseUrl(config, 'GEEKAI_API_BASE_URL', 'https://geekai.co/api/v1'),
        apiKeyEnv: config.apiKeyEnv || 'GEEKAI_API_KEY',
        path: '/audio/speech',
        authHeaders: apiKey => ({ Authorization: `Bearer ${apiKey}` }),
        responseMode: 'binary',
      };
    case 'newapi-audio-speech':
      return {
        apiBaseUrl: resolveBaseUrl(config, 'NEWAPI_API_BASE_URL', 'https://your-newapi-server-address'),
        apiKeyEnv: config.apiKeyEnv || 'NEWAPI_API_KEY',
        path: '/v1/audio/speech',
        authHeaders: apiKey => ({ Authorization: `Bearer ${apiKey}` }),
        responseMode: 'binary',
      };
    case 'openai-audio-speech':
      return {
        apiBaseUrl: resolveBaseUrl(config, 'OPENAI_AUDIO_API_BASE_URL', ''),
        apiKeyEnv: config.apiKeyEnv || 'OPENAI_AUDIO_API_KEY',
        path: config.apiPath || '/v1/audio/speech',
        authHeaders: apiKey => ({ Authorization: `Bearer ${apiKey}` }),
        responseMode: 'binary',
      };
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

function buildMimoPayload(config, baseDir) {
  const model = requireField(config.model, 'Missing config.model');
  const text = requireField(
    readTextMaybeInline(config, 'text', 'textFile', baseDir),
    'Missing speech text. Set config.text or config.textFile.',
  );
  const format = config.audio && config.audio.format ? config.audio.format : 'wav';
  const stylePrompt = readTextMaybeInline(config, 'stylePrompt', 'stylePromptFile', baseDir);
  const voiceDesignPrompt = readTextMaybeInline(config, 'voiceDesignPrompt', 'voiceDesignPromptFile', baseDir);

  const messages = [];
  if (model === 'mimo-v2.5-tts-voicedesign') {
    messages.push({
      role: 'user',
      content: requireField(
        voiceDesignPrompt,
        'mimo-v2.5-tts-voicedesign requires voiceDesignPrompt or voiceDesignPromptFile.',
      ),
    });
  } else if (stylePrompt) {
    messages.push({ role: 'user', content: stylePrompt });
  }

  messages.push({ role: 'assistant', content: text });

  const audio = { format };
  if (model === 'mimo-v2.5-tts-voiceclone') {
    audio.voice = loadVoiceSampleDataUri(
      requireField(
        config.voiceSampleFile,
        'mimo-v2.5-tts-voiceclone requires config.voiceSampleFile.',
      ),
      baseDir,
    );
  } else if (config.audio && typeof config.audio.voice === 'string' && config.audio.voice.trim()) {
    audio.voice = config.audio.voice.trim();
  }

  return { model, messages, audio };
}

function buildOpenAiSpeechPayload(config, baseDir, options = {}) {
  const model = requireField(config.model, 'Missing config.model');
  const text = requireField(
    readTextMaybeInline(config, 'text', 'textFile', baseDir),
    'Missing speech text. Set config.text or config.textFile.',
  );

  const payload = {
    model,
    input: text,
    voice: requireField(config.voice, 'Missing config.voice for audio/speech provider.'),
  };

  if (config.responseFormat) payload.response_format = config.responseFormat;
  if (typeof config.speed === 'number') payload.speed = config.speed;

  const instructions = readTextMaybeInline(config, 'instructions', 'instructionsFile', baseDir);
  if (instructions) payload.instructions = instructions;

  if (options.allowGeekAiFields) {
    if (config.streamFormat) payload.stream_format = config.streamFormat;
    if (typeof config.retries === 'number') payload.retries = config.retries;
  }

  return payload;
}

async function main() {
  const configArg = process.argv.find(arg => arg.startsWith('--config='));
  if (!configArg) usageAndExit();

  loadEnvFile(path.join(REPO_ROOT, '.env'));
  loadEnvFile(path.join(REPO_ROOT, '.env.local'));

  const configPath = path.resolve(configArg.slice('--config='.length));
  const config = readJson(configPath);
  const configDir = path.dirname(configPath);
  const provider = getProviderSettings(config);

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Environment variable ${provider.apiKeyEnv} is not set.`);
  }

  const endpoint = joinUrl(provider.apiBaseUrl, provider.path);
  const outputPath = resolveFromBase(configDir, requireField(config.output, 'Missing config.output'));

  console.log(`▸ Generating TTS with ${config.provider}:${config.model}`);
  console.log(`  config: ${configPath}`);
  console.log(`  endpoint: ${endpoint}`);
  console.log(`  output: ${outputPath}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (provider.responseMode === 'json-base64') {
    const payload = buildMimoPayload(config, configDir);
    const response = await requestJson(endpoint, provider.authHeaders(apiKey), payload);
    const audioData = response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message &&
      response.choices[0].message.audio &&
      response.choices[0].message.audio.data;

    if (!audioData) {
      throw new Error(`MiMo API response does not contain audio data: ${JSON.stringify(response)}`);
    }
    fs.writeFileSync(outputPath, Buffer.from(audioData, 'base64'));
  } else {
    const payload = buildOpenAiSpeechPayload(
      config,
      configDir,
      { allowGeekAiFields: config.provider === 'geekai-audio-speech' },
    );
    const audioBuffer = await requestBinary(endpoint, provider.authHeaders(apiKey), payload);
    fs.writeFileSync(outputPath, audioBuffer);
  }

  console.log(`✓ Saved TTS audio: ${outputPath}`);
}

main().catch(error => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
