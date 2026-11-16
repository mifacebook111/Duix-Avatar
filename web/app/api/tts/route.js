/**
 * POST /api/tts — Voz de la asesora (100% gratuita e ilimitada).
 * Motor: Microsoft Edge Neural TTS vía `msedge-tts` (misma tecnología que
 * "Leer en voz alta" de Edge: voces neuronales, sin clave ni cuota).
 *
 * Voz: es-ES-ElviraNeural (español de España, femenino, cálida).
 * Con `wordBoundaryEnabled` el motor devuelve los límites de palabra reales
 * (offset/duración) y los convertimos en visemas Oculus para el lip-sync
 * de TalkingHead.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { wordsToVisemeTrack } from '../../../lib/es-visemes';

export const runtime = 'nodejs';
export const maxDuration = 30;

const VOICE = process.env.TTS_VOICE || 'es-ES-ElviraNeural';
// Dulzor y calma: algo más lenta y con un punto de tono ascendente
const PROSODY = { rate: '-4%', pitch: '+3Hz' };

/** Limpia el texto para habla natural (quita markdown y símbolos). */
function forSpeech(text) {
  return String(text ?? '')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Normaliza los mensajes de metadata a una lista de palabras con tiempos.
 *  El metadataStream emite un documento JSON `{"Metadata":[...]}` por chunk
 *  (sin separadores entre chunks), posiblemente partido entre chunks. */
function extractWordBoundaries(chunks) {
  const words = [];
  let pending = '';

  const handleDoc = (doc) => {
    // cada doc es {"Metadata":[...]} o directamente una entrada suelta
    const entries = Array.isArray(doc?.Metadata) ? doc.Metadata : [doc];
    for (const entry of entries) {
      if (entry?.Type !== 'WordBoundary') continue;
      const data = entry.Data;
      const text = data?.text?.Text || data?.Text || '';
      // Azure mide en unidades de 100 ns (ticks)
      const offsetMs = (data?.Offset ?? 0) / 10000;
      const durationMs = (data?.Duration ?? 0) / 10000;
      if (text) words.push({ text, offsetMs, durationMs });
    }
  };

  const tryParse = (s) => {
    if (!s.trim()) return true;
    try {
      handleDoc(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  };

  for (const chunk of chunks) {
    pending += Buffer.from(chunk).toString('utf8');
    if (tryParse(pending)) {
      pending = '';
      continue;
    }
    // varios documentos pegados: separa en la frontera "}{" de nivel raíz
    const parts = pending.split(/\}\s*(?=\{)/);
    pending = parts.pop() ?? '';
    for (const part of parts) tryParse(part + '}');
  }
  tryParse(pending);

  return words;
}

async function collect(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('close', () => resolve(chunks));
    stream.on('end', () => resolve(chunks));
    stream.on('error', reject);
  });
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
  }

  const text = forSpeech(body?.text);
  if (!text) {
    return Response.json({ error: 'Texto vacío' }, { status: 400 });
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: true,
      sentenceBoundaryEnabled: false,
    });

    const { audioStream, metadataStream } = await tts.toStream(text, PROSODY);
    const [audioChunks, metaChunks] = await Promise.all([
      collect(audioStream),
      collect(metadataStream).catch(() => []),
    ]);

    const audio = Buffer.concat(audioChunks);
    if (!audio.length) {
      return Response.json({ error: 'El motor TTS no devolvió audio' }, { status: 502 });
    }

    // Palabras reales del motor -> visemas sincronizados
    const wordBoundaries = extractWordBoundaries(metaChunks);
    const track = wordBoundaries.length
      ? wordsToVisemeTrack(wordBoundaries)
      : { visemes: [], vtimes: [], vdurations: [] };

    return Response.json(
      {
        audio: audio.toString('base64'),
        mime: 'audio/mpeg',
        sampleRate: 24000,
        voice: VOICE,
        words: wordBoundaries.length,
        ...track,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return Response.json(
      { error: `Error de síntesis: ${err?.message || err}` },
      { status: 502 },
    );
  }
}
