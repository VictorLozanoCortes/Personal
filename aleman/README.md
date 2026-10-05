# Alemán diario

PWA personal para practicar alemán con situaciones reales en Hamburgo: escribo primero, Claude corrige, y mis errores se convierten en tarjetas de repaso (SM-2).

MVP: sesión diaria (repaso → misión → cierre), misiones con escenarios precargados y propios, banco de errores, repaso espaciado y el atajo «Lo necesito ahora».

## Estructura

- `public/` — la app (HTML/CSS/JS sin build), service worker y manifest.
- `netlify/functions/api.mts` — función serverless en `/api/*`:
  - `POST /api/corregir` — corrige un texto (misión o respuesta a un mensaje) con Claude y devuelve JSON estructurado.
  - `POST /api/escenario` — convierte una línea («pedir al Vermieter…») en una misión.
  - `GET|PUT /api/datos` — guarda/recupera el estado en Netlify Blobs (sincronización entre dispositivos).

Los datos viven en el navegador (`localStorage`) y se sincronizan con Netlify Blobs. En Ajustes se pueden exportar/importar como JSON.

## Desplegar en Netlify

1. Nuevo proyecto en Netlify desde este repo con **Base directory** = `aleman` (el `netlify.toml` ya define `publish = "public"`).
2. Variables de entorno (Project configuration → Environment variables):
   - `ANTHROPIC_API_KEY`: tu clave de la API de Anthropic (nunca llega al navegador).
   - `APP_TOKEN`: una contraseña larga inventada por ti; la app la pide una vez por dispositivo. Protege la API para que nadie más gaste tu saldo.
   - Opcional: `CLAUDE_MODEL` (por defecto `claude-opus-5-5`).
3. Abre la URL en el móvil → Ajustes → pega `APP_TOKEN` → «Añadir a pantalla de inicio».

## Desarrollo local

```bash
npm install
npx netlify dev   # con ANTHROPIC_API_KEY y APP_TOKEN en el entorno o en .env
```
