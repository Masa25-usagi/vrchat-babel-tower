const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const osc = require('node-osc');

const PORT = Number(process.env.PORT || 3000);
const VRCHAT_OSC_HOST = process.env.VRCHAT_OSC_HOST || '127.0.0.1';
const VRCHAT_OSC_PORT = Number(process.env.VRCHAT_OSC_PORT || 9000);
const MAX_MESSAGE_LENGTH = 144;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const oscClient = new osc.Client(VRCHAT_OSC_HOST, VRCHAT_OSC_PORT);

app.use(express.json());
app.use(express.static(__dirname));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    websocketClients: wss.clients.size,
    osc: {
      host: VRCHAT_OSC_HOST,
      port: VRCHAT_OSC_PORT,
    },
  });
});

function normalizeMessage(input) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function sendOscMessage(message) {
  return new Promise((resolve, reject) => {
    oscClient.send('/chatbox/input', message, true, false, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function handleOutgoingMessage(payload) {
  const sourceText = normalizeMessage(payload.sourceText);
  const translatedText = normalizeMessage(payload.translatedText);
  const outgoingText = translatedText || sourceText;
  const sendToVrchat = payload.sendToVrchat !== false;

  if (!outgoingText) {
    throw new Error('送信するテキストが空です');
  }

  if (sendToVrchat) {
    await sendOscMessage(outgoingText);
  }

  return {
    ok: true,
    sentText: outgoingText,
    sourceText,
    translatedText,
    sendToVrchat,
    timestamp: new Date().toISOString(),
  };
}

function sendVoiceToggle(enabled) {
  return new Promise((resolve, reject) => {
    oscClient.send('/input/Voice', enabled ? 1 : 0, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

app.post('/api/chatbox', async (req, res) => {
  try {
    const result = await handleOutgoingMessage(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post('/api/voice-toggle', async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await sendVoiceToggle(enabled);
    res.json({
      ok: true,
      enabled,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'status',
      status: 'connected',
      oscHost: VRCHAT_OSC_HOST,
      oscPort: VRCHAT_OSC_PORT,
      timestamp: new Date().toISOString(),
    })
  );

  socket.on('message', async (rawData) => {
    try {
      const payload = JSON.parse(String(rawData));
      const result = await handleOutgoingMessage(payload);
      socket.send(
        JSON.stringify({
          type: result.sendToVrchat ? 'sent' : 'preview',
          ...result,
        })
      );
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: 'error',
          error: error.message,
          timestamp: new Date().toISOString(),
        })
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`Babel Tower server listening on http://localhost:${PORT}`);
  console.log(`OSC target ${VRCHAT_OSC_HOST}:${VRCHAT_OSC_PORT}`);
});

process.on('SIGINT', () => {
  oscClient.close();
  server.close(() => process.exit(0));
});
