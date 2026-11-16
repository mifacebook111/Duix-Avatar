# 🌐 Avatar Asesora IA — rama `web-vercel`

Asesora virtual conversacional con **avatar 3D hiperrealista**, **lip-sync en tiempo
real**, **voz neural en español de España** e **inteligencia LLM**. Stack **100% gratuita**,
pensada para desplegarse en **Vercel** desde la carpeta `web/` (Root Directory).

> Rama aislada para la web: el código original de Duix (Electron + Docker/GPU) queda
> intacto en `main`. Esta rama solo añade la carpeta `web/`.

## ✨ Características

| Capa | Tecnología | Coste |
|---|---|---|
| Avatar 3D + lip-sync | [TalkingHead](https://github.com/met4citizen/TalkingHead) (Three.js/WebGL) + `mpfb.glb` (CC0) | Gratis |
| Cerebro (LLM) | **Groq** · `llama-3.3-70b-versatile` (API compatible OpenAI, streaming) | Gratis |
| Voz (TTS) | **Microsoft Edge Neural TTS** vía [`msedge-tts`](https://github.com/Migushthe2nd/MsEdgeTTS) · voz `es-ES-ElviraNeural` | Gratis e ilimitado |
| Micrófono (STT) | **Web Speech API** nativa del navegador (`es-ES`, latencia ~0) | Gratis |
| Lip-sync | Visemas Oculus generados en el servidor con los *word boundaries* reales del motor TTS | Gratis |
| Fondos de consultoría | 3 escenas SVG originales (energía, inmobiliario, noche) con selector en pantalla y luz del avatar adaptada a cada escena | Gratis |

## 🎨 Diseño del escenario

El avatar se presenta en un despacho de asesoría. Un selector discreto (abajo a la
izquierda del escenario) cambia el fondo con transición suave y ajusta la
iluminación 3D del avatar a cada ambiente:

| Fondo | Escena | Luz |
|---|---|---|
| **Energía** | Despacho luminoso con infografía de eficiencia (casa + escala A-G) y libros técnicos | Luz cálida de día, intensa |
| **Inmobiliario** | Estantería con carpeteros, maqueta de edificio, planos y gráfico de mercado | Luz cálida de tarde |
| **Noche** | Lámpara de despacho, panel "Ahorra Energía, Ahorra Dinero" y ciudad de noche con bokeh | Ambiente oscuro con foco cálido |

Las escenas son ilustraciones vectoriales (SVG) creadas para este proyecto —
sin dependencias externas y con un peso de pocos KB cada una. La preferencia
queda guardada en el navegador (`localStorage`).

> Nota sobre la apariencia del avatar 3D: el modelo `mpfb.glb` (CC0) es el
> único avatar conversacional con lip-sync de calidad disponible con licencia
> libre en 2026 (el CDN de Ready Player Me desapareció). El color de pelo se
> tiñe en caliente hacia castaño oscuro cálido; el rostro exacto de unas fotos
> de referencia no es reproducible sobre un modelo CC0 genérico.

## 🗣️ Personalidad de Alba

Asesora experta multidisciplinar (eficiencia energética, mercado inmobiliario, finanzas
e inversiones… y cualquier tema complejo), con nivel cultural alto, vocabulario rico,
educación exquisita, empatía y escucha activa. Habla por voz en turnos breves y
conversacionales (ver `app/api/chat/route.js` → `SYSTEM_PROMPT`).

## 🚀 Desarrollo local

```bash
cd web
pnpm install          # importante: pnpm (msedge-tts lo exige)
cp .env.example .env.local   # o crea .env.local con tu GROQ_API_KEY
pnpm dev              # http://localhost:3000
```

Requisitos: **Chrome o Edge** (para el micrófono con Web Speech API) y Node 18+.

## ☁️ Despliegue en Vercel

El proyecto se despliega usando la carpeta `web/` como **Root Directory**:

```bash
cd web
vercel link                 # crea el proyecto con Root Directory = web
vercel env add GROQ_API_KEY production
vercel --prod
```

Variables de entorno:

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GROQ_API_KEY` | ✅ | Clave gratuita de [console.groq.com](https://console.groq.com) |
| `TTS_VOICE` | ❌ | Voz neural alternativa (defecto: `es-ES-ElviraNeural`) |

## 🏗️ Arquitectura

```
web/
├─ app/
│  ├─ page.js              # UI: avatar 3D, STT, pipeline de streaming
│  ├─ layout.js            # metadatos
│  ├─ globals.css          # Tailwind v4 + estilos
│  └─ api/
│     ├─ chat/route.js     # POST → Groq (streaming texto)
│     └─ tts/route.js      # POST → msedge-tts (MP3 + visemas sincronizados)
├─ lib/
│  └─ es-visemes.js        # español → visemas Oculus (grafo-fonético)
└─ public/
   ├─ avatars/
   │  └─ mpfb.glb          # avatar femenino CC0 (MakeHuman/MPFB)
   └─ fondos/
      ├─ despacho-energia.svg        # escena: asesoría energética
      ├─ despacho-inmobiliario.svg   # escena: asesoría inmobiliaria
      └─ modo-noche.svg              # escena: modo noche
```

**Pipeline de conversación:**
1. El usuario habla (Web Speech API `es-ES`) o escribe.
2. `/api/chat` transmite la respuesta de Llama 3.3 70B por streaming.
3. El cliente trocea por frases → `/api/tts` devuelve MP3 + visemas.
4. `TalkingHead.speakAudio()` reproduce cada frase en cola con lip-sync,
   contacto visual, parpadeo y micro-gestos — mientras el LLM sigue generando.

## 📄 Licencias

- Avatar `mpfb.glb`: **CC0** (MakeHuman / MPFB — dominio público).
- Librería TalkingHead: MIT. `msedge-tts`: MIT.
- El resto del código de esta rama: mismo licenciamiento que el repositorio base.
