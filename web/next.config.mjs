/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // El repo base (Duix) tiene su propio package-lock.json en la raíz:
  // fijamos la raíz de tracing a esta carpeta web para evitar ambigüedades.
  outputFileTracingRoot: import.meta.dirname,
  // msedge-tts depende de `ws`/`axios`: mejor como paquete externo en el runtime Node
  serverExternalPackages: ['msedge-tts'],
};

export default nextConfig;
