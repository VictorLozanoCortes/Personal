import type { Config, Context } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const CATEGORIAS = ["genero", "caso", "orden_verbo", "preposicion", "vocabulario", "registro", "otro"];

const SCHEMA_CORRECCION = {
  type: "object",
  additionalProperties: false,
  required: ["texto_corregido", "version_nativa", "errores", "frase_dificil", "comentario"],
  properties: {
    texto_corregido: { type: "string" },
    version_nativa: { type: "string" },
    errores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["categoria", "frase_mala", "frase_buena", "explicacion", "cambia_sentido", "tarjeta"],
        properties: {
          categoria: { type: "string", enum: CATEGORIAS },
          frase_mala: { type: "string" },
          frase_buena: { type: "string" },
          explicacion: { type: "string" },
          cambia_sentido: { type: "boolean" },
          tarjeta: {
            type: "object",
            additionalProperties: false,
            required: ["frase_con_hueco", "respuesta", "frase_incorrecta", "frase_correcta", "pista"],
            properties: {
              frase_con_hueco: { type: "string" },
              respuesta: { type: "string" },
              frase_incorrecta: { type: "string" },
              frase_correcta: { type: "string" },
              pista: { type: "string" },
            },
          },
        },
      },
    },
    frase_dificil: {
      type: "object",
      additionalProperties: false,
      required: ["original", "correcta", "traduccion_es"],
      properties: {
        original: { type: "string" },
        correcta: { type: "string" },
        traduccion_es: { type: "string" },
      },
    },
    comentario: { type: "string" },
  },
};

const SCHEMA_ESCENARIO = {
  type: "object",
  additionalProperties: false,
  required: ["ambito", "titulo", "contexto", "rol", "registro", "palabras_clave"],
  properties: {
    ambito: { type: "string", enum: ["Vivienda", "Trámites", "Trabajo", "Día a día", "Social", "Propio"] },
    titulo: { type: "string" },
    contexto: { type: "string" },
    rol: { type: "string" },
    registro: { type: "string", enum: ["Sie", "du"] },
    palabras_clave: { type: "array", items: { type: "string" } },
  },
};

const SISTEMA_CORRECCION = `Eres el profesor de alemán de Víctor: hispanohablante nativo, inglés fluido, vive y trabaja en Hamburgo (ventas en e-commerce, mercado DACH). Él escribe primero en alemán y tú corriges después.

Tu salida es JSON con:
- texto_corregido: su texto con los errores corregidos, cambiando lo mínimo y respetando su estilo.
- version_nativa: cómo lo escribiría un hablante nativo en Hamburgo en esa situación, con el registro indicado. Debe ser un texto que pueda enviar tal cual.
- errores: un elemento por error real, ordenados de más a menos importante (primero los que cambian el sentido, luego los que suenan raros). No marques como error lo que solo es una alternativa de estilo; eso va en version_nativa.
  - categoria: genero | caso | orden_verbo | preposicion | vocabulario | registro (Sie/du, formalidad) | otro (conjugación, ortografía, etc.).
  - frase_mala: el fragmento corto tal como lo escribió él (unas pocas palabras, no el párrafo entero).
  - frase_buena: el mismo fragmento corregido.
  - explicacion: una sola línea en español, concreta, con la regla. Ejemplo: "«mit» siempre rige dativo: mit dem Vermieter".
  - cambia_sentido: true si el error cambia o vuelve confuso el significado; false si solo suena raro o es incorrecto pero se entiende.
  - tarjeta: material de repaso basado en ese error, con una frase NUEVA (no copiada de su texto), corta, natural y del mismo contexto, que ejercite exactamente la misma regla.
    - frase_correcta: esa frase completa y correcta.
    - frase_con_hueco: la misma frase con "___" en lugar de la parte que ejercita la regla.
    - respuesta: exactamente lo que va en el hueco (frase_con_hueco con el hueco rellenado = frase_correcta).
    - frase_incorrecta: la misma frase con el mismo tipo de error que cometió él.
    - pista: pista breve en español que no revele la respuesta.
- frase_dificil: la frase de su texto que más le costó. original = como la escribió; correcta = versión corregida; traduccion_es = su significado en español (para que la reescriba sin mirar).
- comentario: una línea en español: qué hizo bien y la única cosa en la que fijarse en el próximo intento.

Si el texto no tiene errores, errores es una lista vacía y lo dices en el comentario. Si escribe parte en inglés o español porque no sabía la palabra, trátalo como error de vocabulario y dale la palabra alemana.`;

const SISTEMA_ESCENARIO = `Convierte la situación que describe Víctor (hispanohablante que vive y trabaja en Hamburgo) en un escenario de práctica de escritura en alemán.
- ambito: el que mejor encaje.
- titulo: corto, en español.
- contexto: 1-2 frases en español que explican la situación y lo que tiene que escribir (un correo, un mensaje, etc.).
- rol: a quién se dirige (p. ej. "Vermieter", "Kundin bei Otto").
- registro: Sie o du según lo que sería natural en Alemania.
- palabras_clave: 3-5 palabras o expresiones en alemán que probablemente necesitará, con artículo si son sustantivos.`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function llamarClaude(sistema: string, usuario: string, schema: Record<string, unknown>, effort: "low" | "medium") {
  const client = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
  const response = await client.beta.messages.create({
    model: Netlify.env.get("CLAUDE_MODEL") || "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: sistema,
    messages: [{ role: "user", content: usuario }],
    output_config: { effort, format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "refusal") throw new Error("Claude no pudo procesar este texto. Prueba a reformularlo.");
  if (response.stop_reason === "max_tokens") throw new Error("La respuesta se cortó. Prueba con un texto más corto.");
  const texto = response.content.find((b) => b.type === "text");
  if (!texto || texto.type !== "text") throw new Error("Respuesta vacía de Claude.");
  return JSON.parse(texto.text);
}

async function corregir(body: any) {
  const texto = String(body.texto || "").trim();
  if (!texto) return json({ error: "Falta el texto." }, 400);
  if (texto.length > 6000) return json({ error: "Texto demasiado largo (máx. 6000 caracteres)." }, 400);

  let usuario: string;
  if (body.modo === "ahora") {
    usuario = `Situación: Víctor tiene que contestar este mensaje real que ha recibido.

<mensaje_recibido>
${String(body.mensaje || "").slice(0, 6000)}
</mensaje_recibido>

Elige el registro (Sie/du) según el mensaje recibido. La version_nativa es la respuesta lista para enviar, completa (saludo y despedida incluidos si corresponde).

<respuesta_de_victor>
${texto}
</respuesta_de_victor>`;
  } else {
    const e = body.escenario || {};
    usuario = `Escenario: ${e.titulo || "libre"}
Contexto: ${e.contexto || "-"}
Interlocutor: ${e.rol || "-"}
Registro esperado: ${e.registro || "Sie"}

<texto_de_victor>
${texto}
</texto_de_victor>`;
  }

  const resultado = await llamarClaude(SISTEMA_CORRECCION, usuario, SCHEMA_CORRECCION, "medium");
  return json(resultado);
}

async function crearEscenario(body: any) {
  const linea = String(body.descripcion || "").trim();
  if (!linea) return json({ error: "Describe la situación en una línea." }, 400);
  const resultado = await llamarClaude(SISTEMA_ESCENARIO, linea.slice(0, 1000), SCHEMA_ESCENARIO, "low");
  return json(resultado);
}

async function datos(req: Request) {
  const store = getStore("aleman");
  if (req.method === "GET") {
    const estado = await store.get("estado", { type: "json" });
    return json(estado ?? null);
  }
  if (req.method === "PUT") {
    const estado = await req.json();
    await store.setJSON("estado", estado);
    return json({ ok: true });
  }
  return json({ error: "Método no permitido." }, 405);
}

export default async (req: Request, context: Context) => {
  const token = Netlify.env.get("APP_TOKEN");
  if (!token) return json({ error: "Falta configurar APP_TOKEN en Netlify." }, 500);
  if (req.headers.get("x-app-token") !== token) return json({ error: "Clave de acceso incorrecta." }, 401);

  const ruta = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  try {
    if (ruta === "datos") return await datos(req);
    if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
    if (!Netlify.env.get("ANTHROPIC_API_KEY")) return json({ error: "Falta configurar ANTHROPIC_API_KEY en Netlify." }, 500);
    const body = await req.json();
    if (ruta === "corregir") return await corregir(body);
    if (ruta === "escenario") return await crearEscenario(body);
    return json({ error: "Ruta desconocida." }, 404);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Demasiadas peticiones; espera un momento." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "La API key de Anthropic no es válida." }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `Error de la API de Claude (${err.status}).` }, 502);
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "Error inesperado." }, 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
