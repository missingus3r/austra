import express from 'express';
import logger from '../utils/logger.js';
import { getWeather } from '../services/weatherService.js';
import { getCurrentRates } from '../services/bcuService.js';

const router = express.Router();

// In-memory conversation history per session (simple, no DB)
const conversations = new Map();
const MAX_HISTORY = 20;
const CONVERSATION_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create conversation history for a session
 */
function getConversation(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const conv = conversations.get(sessionId);
  conv.lastAccess = Date.now();
  return conv;
}

/**
 * Cleanup old conversations periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastAccess > CONVERSATION_TTL) {
      conversations.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Build system context with live data
 */
async function buildContext() {
  const parts = [
    'Sos el asistente IA de Austra, una super app para Uruguay.',
    'Respondé en español rioplatense, de forma concisa y útil.',
    'Podés ayudar con: clima, cotizaciones, información de servicios públicos, y consultas generales.',
    'Fecha actual: ' + new Date().toLocaleDateString('es-UY', { timeZone: 'America/Montevideo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
  ];

  // Try to add live weather
  try {
    const weather = await getWeather();
    if (weather) {
      parts.push(`Clima actual en Montevideo: ${weather.current.temperature}°C, ${weather.current.description}, humedad ${weather.current.humidity}%, viento ${weather.current.wind_speed} km/h.`);
    }
  } catch (e) { /* ignore */ }

  // Try to add exchange rates
  try {
    const rates = await getCurrentRates();
    if (rates?.cotizaciones) {
      const usd = rates.cotizaciones.find(c => c.moneda === 'USD' || c.nombre?.includes('Dólar'));
      if (usd) {
        parts.push(`Cotización USD: compra ${usd.compra}, venta ${usd.venta}.`);
      }
    }
  } catch (e) { /* ignore */ }

  return parts.join('\n');
}

/**
 * @route POST /assistant/chat
 * @desc Send a message to the AI assistant
 * @access Public (rate limited)
 * @body { message: string, sessionId?: string }
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Mensaje requerido' });
    }

    if (message.length > 2000) {
      return res.status(400).json({ success: false, error: 'Mensaje demasiado largo (máximo 2000 caracteres)' });
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return res.status(503).json({ success: false, error: 'Asistente IA no disponible en este momento' });
    }

    // Dynamic import to avoid circular deps
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    });

    const sid = sessionId || req.sessionID || 'anonymous';
    const conv = getConversation(sid);
    const context = await buildContext();

    // Build chat history
    const history = conv.messages.map(m => ({
      role: m.role,
      parts: [{ text: m.text }]
    }));

    const chat = model.startChat({
      history,
      systemInstruction: context,
    });

    const result = await chat.sendMessage(message.trim());
    const response = result.response.text();

    // Save to history
    conv.messages.push({ role: 'user', text: message.trim() });
    conv.messages.push({ role: 'model', text: response });

    // Trim history if too long
    if (conv.messages.length > MAX_HISTORY * 2) {
      conv.messages = conv.messages.slice(-MAX_HISTORY * 2);
    }

    res.json({
      success: true,
      data: {
        response,
        sessionId: sid
      }
    });

  } catch (error) {
    logger.error('Assistant chat error:', error);
    res.status(500).json({
      success: false,
      error: 'Error al procesar tu mensaje. Intentá de nuevo.'
    });
  }
});

/**
 * @route DELETE /assistant/history
 * @desc Clear conversation history
 * @body { sessionId: string }
 */
router.delete('/history', (req, res) => {
  const sid = req.body?.sessionId || req.sessionID || 'anonymous';
  conversations.delete(sid);
  res.json({ success: true, message: 'Historial borrado' });
});

export default router;
