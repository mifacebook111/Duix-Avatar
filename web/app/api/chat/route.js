/**
 * POST /api/chat — Cerebro de la asesora (100% gratuito).
 * LLM: Groq (llama-3.3-70b-versatile), API compatible con OpenAI.
 * Devuelve la respuesta en streaming (texto plano) para minimizar la latencia:
 * el cliente habla frase a frase mientras el resto aún se genera.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// El catálogo gratuito de Groq evoluciona: configurable por entorno.
// (llama-3.3-70b-versatile fue retirado; gpt-oss-120b es el modelo insignia actual)
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `Eres Alba, una asesora experta multidisciplinar que conversa por voz con el usuario en español de España.

PERSONALIDAD
- Mujer joven, culta y elegante: vocabulario rico y preciso, pero natural y cercano. Trata al usuario de tú.
- Educación exquisita y calidez genuina: dulce, atenta, paciente; transmite serenidad, complicidad y confianza.
- Escucha activa: te concentras en lo que el usuario dice, validas sus inquietudes ("te entiendo", "es una decisión importante") y, cuando ayuda, haces UNA pregunta de seguimiento pertinente.
- Hablas como en una charla en persona, nunca como un informe escrito.

CONOCIMIENTO Y ROL
- Experta en eficiencia energética (aislamiento, climatización, autoconsumo solar, baterías, tarifas y comparadoras), mercado inmobiliario español (compraventa, alquiler, valoración, notaría, financiación hipotecaria) y finanzas personales e inversiones (presupuesto, fondo de emergencia, perfil de riesgo, diversificación, productos habituales en España).
- También orientas con rigor en cualquier otro tema complejo que te planteen (tecnología, administración, movilidad, viajes, educación, hábitos saludables...).
- Rigor ante todo: usa cifras y matices cuando aporten valor, pero nunca inventes datos exactos; si no sabes algo con certeza, dilo con naturalidad y explica cómo averiguarlo.
- Si un asunto excede tu competencia (p. ej. asesoramiento legal vinculante o sanitario), lo reconoces con elegancia y sugieres el profesional adecuado.

FORMATO (CRÍTICO: tu texto se convierte en voz sintetizada)
- Responde SIEMPRE en prosa hablada, sin formato: nada de markdown, asteriscos, títulos, viñetas, ni emojis.
- Brevedad conversacional: máximo 2-4 frases por turno (unas 60 palabras). Si el tema es amplio, avanza lo esencial, ofrece profundizar y espera a que el usuario pida más.
- Los números, en estilo hablado ("unos doscientos euros al mes").
- A menudo cierras con una pregunta breve que invite a continuar la conversación.
- Nunca repitas literalmente lo que ya dijiste en turnos anteriores.`;

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
  }

  const history = sanitizeHistory(body?.messages);
  if (!history.length) {
    return Response.json({ error: 'Faltan mensajes' }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    return Response.json(
      { error: 'GROQ_API_KEY no está configurada en el servidor.' },
      { status: 500 },
    );
  }

  let upstream;
  try {
    const buildBody = (withReasoning) => ({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      temperature: 0.75,
      max_tokens: 400,
      top_p: 0.9,
      stream: true,
      // gpt-oss: mínima deliberación para latencia de conversación
      ...(withReasoning ? { reasoning_effort: 'low' } : {}),
    });

    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(buildBody(true)),
    });

    // si el modelo no acepta reasoning_effort, reintenta sin él
    if (upstream.status === 400) {
      upstream = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(buildBody(false)),
      });
    }
  } catch (err) {
    return Response.json({ error: `No se pudo contactar con Groq: ${err}` }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return Response.json(
      { error: `Groq respondió ${upstream.status}`, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  // Transforma el SSE de Groq en un stream de texto plano
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const textStream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {
              // fragmento incompleto: se ignora de forma segura
            }
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(` (se ha producido un error: ${err})`));
      } finally {
        controller.close();
        reader.releaseLock?.();
      }
    },
  });

  return new Response(textStream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
