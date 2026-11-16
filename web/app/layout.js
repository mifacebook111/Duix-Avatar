import './globals.css';

export const metadata = {
  title: 'Alba · Asesora IA conversacional',
  description:
    'Asesora virtual con avatar 3D hiperrealista, lip-sync en tiempo real, voz neural en español e inteligencia Groq (Llama 3.3 70B). 100% gratuita.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
