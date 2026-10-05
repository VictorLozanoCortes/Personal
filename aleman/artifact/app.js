"use strict";

// ───────────────────────── utilidades ─────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fecha = (d = new Date()) => d.toLocaleDateString("sv-SE"); // YYYY-MM-DD en hora local
const hoy = () => fecha();
const sumarDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return fecha(d); };
const fechaBonita = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
const contarPalabras = (t) => (String(t).trim().match(/\S+/g) || []).length;
const normalizar = (t) => String(t || "").toLowerCase().replace(/[.,!?;:«»„“”"'()¿¡–—-]/g, " ").replace(/\s+/g, " ").trim();

const CATEGORIAS = {
  genero: "Género",
  caso: "Caso",
  orden_verbo: "Orden del verbo",
  preposicion: "Preposición",
  vocabulario: "Vocabulario",
  registro: "Registro Sie/du",
  otro: "Otro",
};
const AMBITOS = ["Vivienda", "Trámites", "Trabajo", "Día a día", "Social", "Propio"];

// ───────────────────────── estado y persistencia ─────────────────────────
// La fuente de verdad es la base de datos privada del artifact (db). localStorage
// solo es una copia rápida para pintar al abrir.
const CLAVE_LOCAL = "aleman.cache.v1";

function estadoNuevo() {
  return { version: 1, updatedAt: 0, escenarios: [], intentos: [], errores: [], tarjetas: [], dias: {}, borradores: {}, sesion: null };
}

let S = (() => {
  try { return { ...estadoNuevo(), ...JSON.parse(localStorage.getItem(CLAVE_LOCAL)) }; }
  catch { return estadoNuevo(); }
})();

let DB = null, UID = null, listoDatos = false;
const escrito = new Map(); // clave de documento -> JSON ya guardado
const refPerfil = () => DB.doc(`data/users/${UID}/perfil`);
const colErrores = () => refPerfil().collection("errores");
const colIntentos = () => refPerfil().collection("intentos");
const copia = (x) => JSON.parse(JSON.stringify(x));

// Un documento para el perfil, uno por error (con su tarjeta) y uno por intento.
function documentos(estado = S) {
  const docs = new Map();
  const { errores, tarjetas, intentos, ...perfil } = estado;
  docs.set("perfil", perfil);
  for (const e of errores) docs.set("e:" + e.id, { error: e, tarjeta: tarjetas.find((t) => t.errorId === e.id) || null });
  for (const i of intentos) docs.set("i:" + i.id, i);
  return docs;
}
function refDe(clave) {
  if (clave === "perfil") return refPerfil();
  const [tipo, id] = clave.split(":");
  return (tipo === "e" ? colErrores() : colIntentos()).doc(id);
}

let temporizador = null;
function guardar({ sync = true } = {}) {
  S.updatedAt = Date.now();
  try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(S)); } catch {}
  if (!sync || !DB || !listoDatos) return;
  clearTimeout(temporizador);
  temporizador = setTimeout(volcar, 800);
}

// Escribe solo los documentos que cambiaron, de uno en uno.
let volcando = false, otraVez = false, reintentoPendiente = false;
async function volcar() {
  if (volcando) { otraVez = true; return; }
  volcando = true;
  try {
    do {
      otraVez = false;
      marcarSync("guardando…");
      const docs = documentos();
      for (const [k, v] of docs) {
        const j = JSON.stringify(v);
        if (escrito.get(k) !== j) { await refDe(k).set(JSON.parse(j)); escrito.set(k, j); }
      }
      for (const k of [...escrito.keys()]) if (!docs.has(k)) { await refDe(k).delete(); escrito.delete(k); }
    } while (otraVez);
    marcarSync("✓ guardado");
  } catch (e) {
    console.error(e);
    marcarSync("sin guardar");
    if (e?.code === "unavailable" && !reintentoPendiente) {
      reintentoPendiente = true;
      setTimeout(() => { reintentoPendiente = false; volcar(); }, 2000 + Math.random() * 2000);
    }
  } finally { volcando = false; }
}

function marcarSync(texto) { $("#sync").textContent = texto; }

async function iniciarDatos() {
  marcarSync("cargando…");
  const [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  const id = user ? await user.id() : null;
  if (!db || !id) { marcarSync("solo en este dispositivo"); return; }
  DB = db; UID = id;
  try {
    const [p, es, is] = await Promise.all([refPerfil().get(), colErrores().limit(1000).get(), colIntentos().limit(1000).get()]);
    if (p.exists) {
      const remoto = { ...estadoNuevo(), ...copia(p.data()), errores: [], tarjetas: [], intentos: [] };
      es.docs.forEach((d) => { const x = copia(d.data()); if (x.error) remoto.errores.push(x.error); if (x.tarjeta) remoto.tarjetas.push(x.tarjeta); });
      remoto.errores.sort((a, b) => (a.creado || 0) - (b.creado || 0));
      remoto.intentos = is.docs.map((d) => copia(d.data())).sort((a, b) => a.creado - b.creado);
      for (const [k, v] of documentos(remoto)) escrito.set(k, JSON.stringify(v));
      // Lo guardado en la cuenta siempre gana a la copia local (que puede ser
      // de otro día o de un dispositivo sin datos); solo se conservan los borradores.
      remoto.borradores = { ...remoto.borradores, ...S.borradores };
      S = remoto;
      try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(S)); } catch {}
      const ocupado = (M && M.fase === "cargando") || A.fase === "cargando";
      if (!ocupado) render();
    }
    listoDatos = true;
    marcarSync("✓ guardado");
    if (S.updatedAt) volcar(); // primera vez con cuenta: sube lo que había en este dispositivo
  } catch (e) {
    console.error(e);
    marcarSync("sin conexión con tus datos");
  }
}

// ───────────────────────── Claude ─────────────────────────
let SAMPLE;
async function pedirClaude(prompt, modelTier) {
  if (SAMPLE === undefined) SAMPLE = await claude.use("sample");
  if (!SAMPLE) throw new Error("Claude no está disponible aquí. Abre la app desde claude.ai con tu cuenta.");
  try { return await SAMPLE.json(prompt, { modelTier }); }
  catch (e) { throw new Error(mensajeClaude(e)); }
}
function mensajeClaude(e) {
  switch (e?.code) {
    case "not_granted": return "La app no tiene permiso para usar Claude. Recarga la página y acepta el permiso.";
    case "rate_limited": return "Has llegado al límite de uso de Claude por ahora. Prueba dentro de un rato.";
    case "session_expired": return "Tu sesión de claude.ai caducó. Vuelve a iniciar sesión y recarga.";
    case "sampling_disabled": return "Claude no está disponible para tu cuenta en artifacts.";
    case "invalid_json": case "empty_completion": return "La corrección llegó incompleta. Pulsa Corregir otra vez.";
    case "refused": return "Claude no procesó este texto. Prueba a reformularlo.";
    case "prompt_too_large": return "El texto es demasiado largo. Prueba con uno más corto.";
    default: return "No se pudo conectar con Claude. Inténtalo otra vez.";
  }
}

const SISTEMA_CORRECCION = `Eres el profesor de alemán de Víctor: hispanohablante nativo, inglés fluido, vive y trabaja en Hamburgo (ventas en e-commerce, mercado DACH). Él escribe primero en alemán y tú corriges después.

Devuelves:
- texto_corregido: su texto con los errores corregidos, cambiando lo mínimo y respetando su estilo.
- version_nativa: cómo lo escribiría un hablante nativo en Hamburgo en esa situación, con el registro indicado. Debe poder enviarse tal cual.
- errores: un elemento por error real, ordenados de más a menos importante (primero los que cambian el sentido, luego los que suenan raros). No marques como error lo que solo es una alternativa de estilo; eso va en version_nativa.
  - categoria: genero | caso | orden_verbo | preposicion | vocabulario | registro (Sie/du, formalidad) | otro (conjugación, ortografía, etc.).
  - frase_mala: el fragmento corto tal como lo escribió él (unas pocas palabras, no el párrafo entero).
  - frase_buena: el mismo fragmento corregido.
  - explicacion: una sola línea en español, concreta, con la regla. Ejemplo: "«mit» siempre rige dativo: mit dem Vermieter".
  - cambia_sentido: true si el error cambia o vuelve confuso el significado; false si se entiende pero es incorrecto o suena raro.
  - tarjeta: material de repaso con una frase NUEVA (no copiada de su texto), corta, natural y del mismo contexto, que ejercite exactamente la misma regla.
    - frase_correcta: esa frase completa y correcta.
    - frase_con_hueco: la misma frase con "___" en lugar de la parte que ejercita la regla.
    - respuesta: exactamente lo que va en el hueco (frase_con_hueco con el hueco rellenado = frase_correcta).
    - frase_incorrecta: la misma frase con el mismo tipo de error que cometió él.
    - pista: pista breve en español que no revele la respuesta.
- frase_dificil: la frase de su texto que más le costó. original = como la escribió; correcta = versión corregida; traduccion_es = su significado en español (para que la reescriba sin mirar).
- comentario: una línea en español: qué hizo bien y la única cosa en la que fijarse en el próximo intento.

Si el texto no tiene errores, errores es una lista vacía y lo dices en el comentario. Si escribe parte en inglés o español porque no sabía la palabra, trátalo como error de vocabulario y dale la palabra alemana.

Responde SOLO con un objeto JSON con exactamente esta forma:
{"texto_corregido": "…", "version_nativa": "…", "errores": [{"categoria": "genero", "frase_mala": "…", "frase_buena": "…", "explicacion": "…", "cambia_sentido": false, "tarjeta": {"frase_con_hueco": "…", "respuesta": "…", "frase_incorrecta": "…", "frase_correcta": "…", "pista": "…"}}], "frase_dificil": {"original": "…", "correcta": "…", "traduccion_es": "…"}, "comentario": "…"}`;

const SISTEMA_ESCENARIO = `Convierte la situación que describe Víctor (hispanohablante que vive y trabaja en Hamburgo) en un escenario de práctica de escritura en alemán.
- ambito: uno de "Vivienda", "Trámites", "Trabajo", "Día a día", "Social", "Propio".
- titulo: corto, en español.
- contexto: 1-2 frases en español que explican la situación y lo que tiene que escribir (un correo, un mensaje, etc.).
- rol: a quién se dirige (p. ej. "Vermieter", "Kundin bei Otto").
- registro: "Sie" o "du" según lo natural en Alemania.
- palabras_clave: 3-5 palabras o expresiones en alemán que probablemente necesitará, con artículo si son sustantivos.

Responde SOLO con un objeto JSON: {"ambito": "…", "titulo": "…", "contexto": "…", "rol": "…", "registro": "Sie", "palabras_clave": ["…"]}`;

const txt = (v) => (typeof v === "string" ? v : "");
function validarCorreccion(r) {
  if (!r || typeof r !== "object" || !txt(r.texto_corregido)) throw new Error("La corrección llegó incompleta. Pulsa Corregir otra vez.");
  const errores = (Array.isArray(r.errores) ? r.errores : []).filter((e) => e && txt(e.frase_mala) && txt(e.frase_buena)).map((e) => ({
    categoria: CATEGORIAS[e.categoria] ? e.categoria : "otro",
    frase_mala: e.frase_mala, frase_buena: e.frase_buena, explicacion: txt(e.explicacion),
    cambia_sentido: e.cambia_sentido === true,
    tarjeta: e.tarjeta && typeof e.tarjeta === "object" ? {
      frase_con_hueco: txt(e.tarjeta.frase_con_hueco), respuesta: txt(e.tarjeta.respuesta),
      frase_incorrecta: txt(e.tarjeta.frase_incorrecta), frase_correcta: txt(e.tarjeta.frase_correcta), pista: txt(e.tarjeta.pista),
    } : {},
  }));
  const fd = r.frase_dificil || {};
  const primera = r.texto_corregido.split(/(?<=[.!?])\s+/)[0];
  return {
    texto_corregido: r.texto_corregido,
    version_nativa: txt(r.version_nativa) || r.texto_corregido,
    errores,
    frase_dificil: { original: txt(fd.original), correcta: txt(fd.correcta) || primera, traduccion_es: txt(fd.traduccion_es) || "(sin traducción)" },
    comentario: txt(r.comentario),
  };
}

async function corregirConClaude({ modo, escenario, mensaje, texto }) {
  let caso;
  if (modo === "ahora") {
    caso = `Situación: Víctor tiene que contestar este mensaje real que ha recibido.

<mensaje_recibido>
${String(mensaje || "").slice(0, 6000)}
</mensaje_recibido>

Elige el registro (Sie/du) según el mensaje recibido. La version_nativa es la respuesta lista para enviar, completa (saludo y despedida incluidos si corresponde).`;
  } else {
    const e = escenario || {};
    caso = `Escenario: ${e.titulo || "libre"}
Contexto: ${e.contexto || "-"}
Interlocutor: ${e.rol || "-"}
Registro esperado: ${e.registro || "Sie"}`;
  }
  const prompt = `${SISTEMA_CORRECCION}\n\n---\n\n${caso}\n\n<texto_de_victor>\n${texto.slice(0, 6000)}\n</texto_de_victor>`;
  return validarCorreccion(await pedirClaude(prompt, "default"));
}

async function escenarioConClaude(descripcion) {
  const r = await pedirClaude(`${SISTEMA_ESCENARIO}\n\nSituación: ${descripcion.slice(0, 1000)}`, "quick");
  if (!r || !txt(r.titulo) || !txt(r.contexto)) throw new Error("No se pudo crear la misión. Prueba a describirla de otra forma.");
  return {
    ambito: AMBITOS.includes(r.ambito) ? r.ambito : "Propio", titulo: r.titulo, contexto: r.contexto,
    rol: txt(r.rol) || "-", registro: r.registro === "du" ? "du" : "Sie",
    palabras_clave: (Array.isArray(r.palabras_clave) ? r.palabras_clave : []).filter((p) => typeof p === "string").slice(0, 5),
  };
}

// Botón que pide un segundo toque para confirmar (el visor no muestra diálogos).
function dobleToque(el, aviso, accion) {
  el.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (el.dataset.armado) { accion(); return; }
    el.dataset.armado = "1";
    const original = el.textContent;
    el.textContent = aviso;
    el.classList.add("peligro");
    setTimeout(() => { if (el.isConnected) { delete el.dataset.armado; el.textContent = original; el.classList.remove("peligro"); } }, 4000);
  });
}

function marcarDia(campo, n = 1) {
  const d = (S.dias[hoy()] ||= { repasos: 0, misiones: 0, completa: false });
  d[campo] = (d[campo] || 0) + n;
}

// ───────────────────────── datos derivados ─────────────────────────
const todosEscenarios = () => [...window.ESCENARIOS_INICIALES, ...S.escenarios];
const escenarioPorId = (id) => todosEscenarios().find((e) => e.id === id);
const errorPorId = (id) => S.errores.find((e) => e.id === id);
const pendientesHoy = () => S.tarjetas.filter((t) => t.proxima <= hoy() && errorPorId(t.errorId)).sort((a, b) => a.proxima.localeCompare(b.proxima));

function racha() {
  const activo = (iso) => { const d = S.dias[iso]; return d && (d.repasos > 0 || d.misiones > 0); };
  let dia = activo(hoy()) ? hoy() : sumarDias(hoy(), -1);
  let n = 0;
  while (activo(dia)) { n++; dia = sumarDias(dia, -1); }
  return n;
}
function diasUltimaSemana() {
  let n = 0;
  for (let i = 0; i < 7; i++) { const d = S.dias[sumarDias(hoy(), -i)]; if (d && (d.repasos || d.misiones)) n++; }
  return n;
}

function elegirEscenario(excluir) {
  const usos = {};
  S.intentos.forEach((i) => { if (i.escenarioId) usos[i.escenarioId] = (usos[i.escenarioId] || 0) + 1; });
  const lista = todosEscenarios().filter((e) => e.id !== excluir);
  const min = Math.min(...lista.map((e) => usos[e.id] || 0));
  const candidatos = lista.filter((e) => (usos[e.id] || 0) === min);
  const semilla = [...hoy()].reduce((a, c) => a + c.charCodeAt(0), 0);
  return candidatos[semilla % candidatos.length].id;
}

// ───────────────────────── SM-2 ─────────────────────────
// calidad: 1 = otra vez, 3 = difícil, 4 = bien, 5 = fácil
function sm2(t, calidad) {
  if (calidad < 3) {
    t.reps = 0;
    t.intervalo = 1;
  } else {
    t.reps += 1;
    t.intervalo = t.reps === 1 ? 1 : t.reps === 2 ? 4 : Math.round(t.intervalo * t.facilidad);
    if (calidad === 5) t.intervalo = Math.max(t.intervalo + 1, Math.round(t.intervalo * 1.3));
  }
  t.facilidad = Math.max(1.3, t.facilidad + (0.1 - (5 - calidad) * (0.08 + (5 - calidad) * 0.02)));
  t.proxima = sumarDias(hoy(), t.intervalo);
  t.historial = [...(t.historial || []), { f: hoy(), q: calidad }].slice(-20);
}

// ───────────────────────── guardar un intento ─────────────────────────
function guardarIntento({ modo, escenarioId, texto, mensaje, resultado }) {
  const intento = {
    id: uid(), modo, escenarioId: escenarioId || null, fecha: hoy(), creado: Date.now(),
    texto, mensaje: mensaje || null, palabras: contarPalabras(texto),
    corregido: resultado.texto_corregido, nativa: resultado.version_nativa,
    fraseDificil: resultado.frase_dificil, comentario: resultado.comentario,
    errores: resultado.errores, // copia completa para volver a mostrar la corrección
    errorIds: [], nuevosIds: [],
  };
  for (const e of resultado.errores) {
    const repetido = S.errores.find((x) => normalizar(x.mala) === normalizar(e.frase_mala) && normalizar(x.buena) === normalizar(e.frase_buena));
    if (repetido) {
      repetido.veces = (repetido.veces || 1) + 1;
      repetido.ultimaVez = hoy();
      const t = S.tarjetas.find((t) => t.errorId === repetido.id);
      if (t) { t.reps = 0; t.intervalo = 1; t.proxima = sumarDias(hoy(), 1); }
      intento.errorIds.push(repetido.id);
      continue;
    }
    const err = {
      id: uid(), intentoId: intento.id, fecha: hoy(), categoria: e.categoria,
      mala: e.frase_mala, buena: e.frase_buena, explicacion: e.explicacion, creado: Date.now(),
      cambiaSentido: e.cambia_sentido, tarjeta: e.tarjeta, veces: 1, ultimaVez: hoy(),
    };
    S.errores.push(err);
    S.tarjetas.push({ id: uid(), errorId: err.id, reps: 0, intervalo: 0, facilidad: 2.5, proxima: sumarDias(hoy(), 1), historial: [] });
    intento.errorIds.push(err.id);
    intento.nuevosIds.push(err.id);
  }
  S.intentos.push(intento);
  marcarDia("misiones");
  guardar();
  return intento;
}

// ───────────────────────── componentes de vista ─────────────────────────
function htmlError(e) {
  const mala = e.frase_mala ?? e.mala, buena = e.frase_buena ?? e.buena;
  const sentido = e.cambia_sentido ?? e.cambiaSentido;
  return `<div class="err ${sentido ? "sentido" : ""}">
    <div class="fix de"><del>${esc(mala)}</del> → <ins>${esc(buena)}</ins></div>
    <div class="small">${esc(e.explicacion)}</div>
    <div style="margin-top:4px"><span class="tag">${esc(CATEGORIAS[e.categoria] || e.categoria)}</span>${sentido ? '<span class="tag bad">cambia el sentido</span>' : '<span class="tag warn">suena raro</span>'}</div>
  </div>`;
}

function htmlCorreccion(r, { modoAhora = false } = {}) {
  const top = r.errores.slice(0, 3), resto = r.errores.slice(3);
  const nativa = `<div class="card">
      <h3>${modoAhora ? "Lista para enviar" : "Versión nativa"}</h3>
      <div class="texto de" id="txt-nativa">${esc(r.version_nativa)}</div>
      <button class="btn sec" data-copiar="txt-nativa">Copiar</button>
    </div>`;
  return `
    ${modoAhora ? nativa : ""}
    <div class="card">
      <p>${esc(r.comentario)}</p>
      ${r.errores.length === 0 ? '<p class="muted">Sin errores. ¡Bien hecho!</p>' : `<h3>${r.errores.length === 1 ? "1 corrección" : `Las ${top.length} correcciones clave`}</h3>`}
      ${top.map(htmlError).join("")}
      ${resto.length ? `<details><summary>Ver ${resto.length} corrección${resto.length > 1 ? "es" : ""} más</summary>${resto.map(htmlError).join("")}</details>` : ""}
    </div>
    <details class="card" ${modoAhora ? "" : "open"}><summary>Tu texto corregido</summary><div class="texto de">${esc(r.texto_corregido)}</div></details>
    ${modoAhora ? "" : nativa}`;
}

function enlazarCopiar(root) {
  $$("[data-copiar]", root).forEach((b) => b.addEventListener("click", async () => {
    const txt = $("#" + b.dataset.copiar).textContent;
    try { await navigator.clipboard.writeText(txt); aviso("Copiado"); } catch { aviso("No se pudo copiar"); }
  }));
}

function aviso(texto) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// diff por palabras (LCS) entre lo que escribí y la frase correcta
function htmlDiff(mio, bien) {
  const a = String(mio).trim().split(/\s+/).filter(Boolean), b = String(bien).trim().split(/\s+/).filter(Boolean);
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const eq = (x, y) => normalizar(x) === normalizar(y);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { out.push(esc(b[j])); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(`<span class="x">${esc(a[i++])}</span>`);
    else out.push(`<span class="y">${esc(b[j++])}</span>`);
  }
  while (i < n) out.push(`<span class="x">${esc(a[i++])}</span>`);
  while (j < m) out.push(`<span class="y">${esc(b[j++])}</span>`);
  return `<div class="texto de diff">${out.join(" ")}</div>`;
}

const cargando = (texto) => `<div class="loading"><div class="spin"></div><div>${esc(texto)}</div></div>`;
const cajaError = (msg) => `<div class="error-box">${esc(msg)}</div>`;

// ───────────────────────── tarjeta de repaso ─────────────────────────
// Pinta una tarjeta en `root` y llama a onFin() cuando la califico.
function pintarTarjeta(root, t, onFin) {
  const e = errorPorId(t.errorId);
  const tj = e.tarjeta || {};
  const tieneHueco = tj.frase_con_hueco && tj.frase_con_hueco.includes("___") && tj.respuesta;
  const tieneCorregir = tj.frase_incorrecta && tj.frase_correcta;
  const tipo = (t.reps % 2 === 0 && tieneHueco) || !tieneCorregir ? (tieneHueco ? "hueco" : "propia") : "corregir";

  let pregunta, esperado, valorInicial = "";
  if (tipo === "hueco") {
    const [antes, despues] = tj.frase_con_hueco.split("___");
    pregunta = `<p class="muted small">Completa el hueco</p><div class="q de">${esc(antes)}<span class="gap">___</span>${esc(despues)}</div>${tj.pista ? `<p class="small muted">Pista: ${esc(tj.pista)}</p>` : ""}`;
    esperado = tj.respuesta;
  } else if (tipo === "corregir") {
    pregunta = `<p class="muted small">Esta frase tiene un error. Escríbela bien</p><div class="q de">${esc(tj.frase_incorrecta)}</div>${tj.pista ? `<p class="small muted">Pista: ${esc(tj.pista)}</p>` : ""}`;
    esperado = tj.frase_correcta;
    valorInicial = tj.frase_incorrecta;
  } else {
    pregunta = `<p class="muted small">Corrige tu propio error</p><div class="q de">${esc(e.mala)}</div>`;
    esperado = e.buena;
    valorInicial = e.mala;
  }

  root.innerHTML = `<div class="card flash">
    <span class="tag">${esc(CATEGORIAS[e.categoria] || e.categoria)}</span>
    ${pregunta}
    <form id="f-resp"><input type="text" id="resp" class="de" autocomplete="off" autocapitalize="off" spellcheck="false" lang="de" value="${esc(valorInicial)}" placeholder="Tu respuesta" />
    <button class="btn" type="submit">Comprobar</button></form>
    <div id="revelar"></div>
  </div>`;
  const input = $("#resp", root);
  if (!valorInicial) input.focus();

  $("#f-resp", root).addEventListener("submit", (ev) => {
    ev.preventDefault();
    const bien = normalizar(input.value) === normalizar(esperado);
    input.disabled = true;
    $("#f-resp button", root).remove();
    $("#revelar", root).innerHTML = `
      <div class="verdict ${bien ? "ok" : "no"}">${bien ? "✓ Correcto" : "✗ No del todo"}</div>
      ${bien ? "" : `<p class="small muted">Correcto:</p>${tipo === "hueco" ? `<div class="texto de">${esc(tj.frase_con_hueco.replace("___", tj.respuesta))}</div>` : htmlDiff(input.value, esperado)}`}
      <p class="small" style="margin-top:10px">${esc(e.explicacion)}</p>
      <p class="small muted">Tu error original: <span class="de"><del>${esc(e.mala)}</del> → <ins>${esc(e.buena)}</ins></span></p>
      <div class="grade">
        <button data-q="1" class="${bien ? "" : "sug"}">Otra vez</button>
        <button data-q="3">Difícil</button>
        <button data-q="4" class="${bien ? "sug" : ""}">Bien</button>
        <button data-q="5">Fácil</button>
      </div>`;
    $$(".grade button", root).forEach((b) => b.addEventListener("click", () => {
      sm2(t, Number(b.dataset.q));
      marcarDia("repasos");
      guardar();
      onFin();
    }));
  });
}

// ───────────────────────── misión ─────────────────────────
// Estado transitorio de la misión abierta (no se persiste salvo el borrador y el intento).
let M = null;

function abrirMision(escenarioId, intentoId = null) {
  if (M && M.escenarioId === escenarioId && M.intentoId === intentoId) return M;
  const intento = intentoId && S.intentos.find((i) => i.id === intentoId);
  M = { escenarioId, intentoId, fase: intento ? "resultado" : "escribir", error: null, reescrito: null };
  return M;
}

function resultadoDeIntento(i) {
  return { texto_corregido: i.corregido, version_nativa: i.nativa, errores: i.errores, frase_dificil: i.fraseDificil, comentario: i.comentario };
}

function pintarMision(root, opts = {}) {
  const { enSesion = false, onTerminar, onCambiar } = opts;
  const e = escenarioPorId(M.escenarioId);
  if (!e) { root.innerHTML = cajaError("Escenario no encontrado."); return; }
  const intento = M.intentoId && S.intentos.find((i) => i.id === M.intentoId);
  const cabecera = `<div class="card">
      <div><span class="tag">${esc(e.ambito)}</span><span class="tag ${e.registro === "du" ? "du" : "sie"}">${esc(e.registro)}</span></div>
      <h2 style="margin-top:8px">${esc(e.titulo)}</h2>
      <p>${esc(e.contexto)}</p>
      <p class="small muted">Te diriges a: <span class="de">${esc(e.rol)}</span></p>
      ${M.fase === "escribir" && e.palabras_clave?.length ? `<details><summary>Pistas: palabras clave</summary><p class="de">${e.palabras_clave.map(esc).join(" · ")}</p></details>` : ""}
      ${M.fase === "escribir" && onCambiar ? `<button class="btn ghost" id="cambiar">Cambiar de misión</button>` : ""}
    </div>`;

  if (M.fase === "escribir" || M.fase === "cargando") {
    const borrador = S.borradores[e.id] || "";
    root.innerHTML = `${cabecera}
      <label for="texto">Escribe tu versión en alemán (aunque salga mal):</label>
      <textarea id="texto" class="de" lang="de" spellcheck="false" autocapitalize="sentences" placeholder="Sehr geehrte …">${esc(borrador)}</textarea>
      ${M.error ? cajaError(M.error) : ""}
      ${M.fase === "cargando" ? cargando("Corrigiendo… suele tardar 10–30 segundos") : `<button class="btn" id="corregir">Corregir</button>`}`;
    const ta = $("#texto", root);
    ta.addEventListener("input", () => { S.borradores[e.id] = ta.value; guardar({ sync: false }); });
    if (M.fase === "cargando") ta.disabled = true;
    $("#cambiar", root)?.addEventListener("click", onCambiar);
    $("#corregir", root)?.addEventListener("click", async () => {
      const texto = ta.value.trim();
      if (contarPalabras(texto) < 3) { M.error = "Escribe al menos una frase completa antes de corregir."; return pintarMision(root, opts); }
      const m = M;
      m.fase = "cargando"; m.error = null; pintarMision(root, opts);
      try {
        const resultado = await corregirConClaude({ modo: "mision", escenario: e, texto });
        const i = guardarIntento({ modo: "mision", escenarioId: e.id, texto, resultado });
        delete S.borradores[e.id]; guardar();
        m.intentoId = i.id; m.fase = "resultado";
        if (enSesion && S.sesion) { S.sesion.intentoId = i.id; guardar(); }
      } catch (err) {
        m.fase = "escribir"; m.error = err.message;
      }
      if (M === m) pintarMision(root, opts);
    });
    return;
  }

  const r = resultadoDeIntento(intento);
  if (M.fase === "resultado") {
    root.innerHTML = `${cabecera}
      <details class="card"><summary>Lo que escribiste</summary><div class="texto de">${esc(intento.texto)}</div></details>
      ${htmlCorreccion(r)}
      <button class="btn" id="reescribir">Reescribir la frase más difícil sin mirar →</button>`;
    enlazarCopiar(root);
    $("#reescribir", root).addEventListener("click", () => { M.fase = "reescribir"; pintarMision(root, opts); scrollTo(0, 0); });
    return;
  }

  if (M.fase === "reescribir") {
    const fd = r.frase_dificil;
    root.innerHTML = `<div class="card">
        <h2>Reescríbela sin mirar</h2>
        <p class="muted small">Esta es la frase que más te costó. Escríbela en alemán, correcta:</p>
        <p style="font-size:1.1rem">«${esc(fd.traduccion_es)}»</p>
        <form id="f-re"><textarea id="re" class="de" lang="de" spellcheck="false" style="min-height:110px" ${M.reescrito != null ? "disabled" : ""}>${esc(M.reescrito || "")}</textarea>
        ${M.reescrito == null ? '<button class="btn" type="submit">Comprobar</button>' : ""}</form>
        <div id="cmp"></div>
      </div>`;
    const mostrar = () => {
      const ok = normalizar(M.reescrito) === normalizar(fd.correcta);
      $("#cmp", root).innerHTML = `<div class="verdict ${ok ? "ok" : "no"}">${ok ? "✓ ¡Perfecta!" : "Casi. Compara (tachado = sobra, verde = falta):"}</div>
        ${ok ? "" : htmlDiff(M.reescrito, fd.correcta)}
        <p class="small muted" style="margin-top:8px">Tu primera versión: <span class="de">${esc(fd.original)}</span></p>
        <button class="btn" id="terminar">${enSesion ? "Ir al cierre →" : "Terminar"}</button>`;
      $("#terminar", root).addEventListener("click", () => onTerminar && onTerminar(intento));
    };
    if (M.reescrito != null) mostrar();
    else {
      $("#re", root).focus();
      $("#f-re", root).addEventListener("submit", (ev) => {
        ev.preventDefault();
        M.reescrito = $("#re", root).value;
        if (!M.reescrito.trim()) { M.reescrito = null; return; }
        $("#re", root).disabled = true; $("#f-re button", root).remove();
        mostrar();
      });
    }
  }
}

// ───────────────────────── pantallas ─────────────────────────
const pantallas = {};

pantallas.hoy = (root) => {
  if (!S.sesion || S.sesion.fecha !== hoy()) {
    const cola = pendientesHoy().slice(0, 10).map((t) => t.id);
    S.sesion = { fecha: hoy(), paso: cola.length ? "repaso" : "mision", cola, hechas: [], escenarioId: elegirEscenario(S.sesion?.escenarioId), intentoId: null };
    guardar({ sync: false });
  }
  const s = S.sesion;
  const pasos = ["repaso", "mision", "cierre"];
  const idx = s.paso === "fin" ? 3 : pasos.indexOf(s.paso);
  const cabecera = `
    <div class="stats">
      <div class="stat"><b>${racha()}</b><span>días de racha</span></div>
      <div class="stat"><b>${diasUltimaSemana()}/7</b><span>esta semana</span></div>
      <div class="stat"><b>${S.errores.length}</b><span>errores guardados</span></div>
    </div>
    <div class="steps">${["Repaso", "Misión", "Cierre"].map((p, i) => `<span class="${i === idx ? "on" : i < idx ? "done" : ""}">${i < idx ? "✓ " : ""}${p}</span>`).join("")}</div>
    <div id="paso"></div>`;
  root.innerHTML = cabecera;
  const paso = $("#paso", root);

  if (s.paso === "repaso") {
    const restantes = s.cola.filter((id) => !s.hechas.includes(id)).map((id) => S.tarjetas.find((t) => t.id === id)).filter((t) => t && errorPorId(t.errorId));
    if (!restantes.length) { s.paso = "mision"; guardar(); return pantallas.hoy(root); }
    paso.innerHTML = `<p class="muted small">Tarjeta ${s.hechas.length + 1} de ${s.cola.length} · de tus propios errores</p><div id="tarjeta"></div>`;
    pintarTarjeta($("#tarjeta", paso), restantes[0], () => { s.hechas.push(restantes[0].id); guardar(); pantallas.hoy(root); scrollTo(0, 0); });
    return;
  }

  if (s.paso === "mision") {
    abrirMision(s.escenarioId, s.intentoId);
    const intro = document.createElement("p");
    intro.className = "muted small";
    intro.textContent = s.cola.length ? "Repaso hecho. Ahora, la misión de hoy:" : "Hoy no tienes tarjetas pendientes. Vamos directo a la misión:";
    paso.before(intro);
    pintarMision(paso, {
      enSesion: true,
      onCambiar: () => {
        root.innerHTML = `<div class="card"><h2>Elige la misión</h2><ul class="list">${todosEscenarios().map((e) => `<li><a href="#" data-id="${esc(e.id)}"><span class="tag">${esc(e.ambito)}</span> ${esc(e.titulo)}</a></li>`).join("")}</ul></div><button class="btn sec" id="volver">Volver</button>`;
        $$("[data-id]", root).forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); s.escenarioId = a.dataset.id; M = null; guardar(); pantallas.hoy(root); scrollTo(0, 0); }));
        $("#volver", root).addEventListener("click", () => pantallas.hoy(root));
      },
      onTerminar: () => { s.paso = "cierre"; guardar(); pantallas.hoy(root); scrollTo(0, 0); },
    });
    return;
  }

  if (s.paso === "cierre") {
    const intento = S.intentos.find((i) => i.id === s.intentoId);
    const nuevos = (intento?.nuevosIds || []).map(errorPorId).filter(Boolean);
    const repetidos = (intento?.errorIds || []).filter((id) => !intento.nuevosIds.includes(id)).map(errorPorId).filter(Boolean);
    const principal = nuevos[0];
    paso.innerHTML = `<div class="card">
        <h2>Cierre</h2>
        ${principal ? `<p>El error nuevo de hoy:</p>${htmlError(principal)}<p class="small muted">Lo repasarás mañana${nuevos.length > 1 ? `, junto con ${nuevos.length - 1} más` : ""}.</p>`
          : `<p>Hoy no hubo errores nuevos. ✨</p>`}
        ${repetidos.length ? `<p class="small" style="margin-top:10px">Repetiste ${repetidos.length} error${repetidos.length > 1 ? "es" : ""} que ya tenías; vuelven a la cola para mañana.</p>` : ""}
      </div>
      <button class="btn" id="fin">Terminar la sesión</button>`;
    $("#fin", paso).addEventListener("click", () => { s.paso = "fin"; S.dias[hoy()] ||= { repasos: 0, misiones: 0 }; S.dias[hoy()].completa = true; guardar(); pantallas.hoy(root); });
    return;
  }

  // fin
  const extra = pendientesHoy().length;
  paso.innerHTML = `<div class="card" style="text-align:center">
      <h2>Sesión de hoy completada ✓</h2>
      <p class="muted">Racha: ${racha()} día${racha() === 1 ? "" : "s"}. Mañana te esperan ${S.tarjetas.filter((t) => t.proxima === sumarDias(hoy(), 1)).length} tarjetas.</p>
    </div>
    ${extra ? `<button class="btn sec" id="mas">Repasar ${Math.min(10, extra)} tarjetas más</button>` : ""}
    <button class="btn sec" data-go="misiones">Hacer otra misión</button>`;
  $("#mas", paso)?.addEventListener("click", () => {
    s.cola = [...s.cola, ...pendientesHoy().slice(0, 10).map((t) => t.id)];
    s.paso = "repaso"; guardar(); pantallas.hoy(root);
  });
};

pantallas.misiones = (root) => {
  const usos = {};
  S.intentos.forEach((i) => { if (i.escenarioId) usos[i.escenarioId] = (usos[i.escenarioId] || 0) + 1; });
  const grupos = AMBITOS.map((a) => [a, todosEscenarios().filter((e) => e.ambito === a)]).filter(([, l]) => l.length);
  root.innerHTML = `
    <div class="card">
      <h2>Mi situación real</h2>
      <p class="small muted">Descríbela en una línea y la convierto en misión.</p>
      <form id="f-nuevo"><input type="text" id="nuevo" placeholder="Ej.: pedir al Vermieter que arregle la persiana" />
      <button class="btn" type="submit">Crear misión</button></form>
      <div id="nuevo-estado"></div>
    </div>
    ${grupos.map(([a, l]) => `<div class="card"><h3>${esc(a)}</h3><ul class="list">${l.map((e) => `
      <li><a href="#" data-go="mision|${encodeURIComponent(e.id)}">${esc(e.titulo)}
        <div class="small muted"><span class="tag ${e.registro === "du" ? "du" : "sie"}">${esc(e.registro)}</span>${usos[e.id] ? `hecha ${usos[e.id]}×` : "sin hacer"}</div></a></li>`).join("")}</ul></div>`).join("")}`;
  $("#f-nuevo", root).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const descripcion = $("#nuevo", root).value.trim();
    if (!descripcion) return;
    const estado = $("#nuevo-estado", root);
    estado.innerHTML = cargando("Preparando la misión…");
    try {
      const e = await escenarioConClaude(descripcion);
      const nuevo = { id: "p-" + uid(), ...e, propio: true };
      S.escenarios.push(nuevo); guardar();
      ir("mision", nuevo.id);
    } catch (err) { estado.innerHTML = cajaError(err.message); }
  });
};

pantallas.mision = (root, id) => {
  abrirMision(decodeURIComponent(id));
  const e = escenarioPorId(M.escenarioId);
  pintarMision(root, {
    onTerminar: (intento) => {
      root.innerHTML = `<div class="card" style="text-align:center"><h2>Misión guardada ✓</h2>
        <p class="muted">${intento.nuevosIds.length} error${intento.nuevosIds.length === 1 ? "" : "es"} nuevo${intento.nuevosIds.length === 1 ? "" : "s"} al banco. Los repasarás a partir de mañana.</p></div>
        <button class="btn" data-go="hoy">Volver a Hoy</button><button class="btn sec" data-go="misiones">Otra misión</button>`;
      M = null;
    },
  });
  if (e?.propio && M.fase === "escribir") {
    root.insertAdjacentHTML("beforeend", `<button class="btn ghost" id="borrar-esc">Eliminar esta misión</button>`);
    dobleToque($("#borrar-esc", root), "Toca otra vez para eliminarla (tus errores se quedan)", () => {
      S.escenarios = S.escenarios.filter((x) => x.id !== e.id); guardar(); ir("misiones");
    });
  }
};

let filtroCategoria = "todas";
pantallas.errores = (root) => {
  const porCat = {};
  S.errores.forEach((e) => { porCat[e.categoria] = (porCat[e.categoria] || 0) + 1; });
  const max = Math.max(1, ...Object.values(porCat));
  const lista = S.errores.filter((e) => filtroCategoria === "todas" || e.categoria === filtroCategoria).slice().reverse();
  const tarjetaDe = (id) => S.tarjetas.find((t) => t.errorId === id);
  root.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${S.errores.length}</b><span>errores</span></div>
      <div class="stat"><b>${pendientesHoy().length}</b><span>para repasar hoy</span></div>
      <div class="stat"><b>${S.tarjetas.filter((t) => t.reps >= 3).length}</b><span>ya dominados</span></div>
    </div>
    ${S.errores.length ? `<div class="card"><h3>Por categoría</h3>${Object.keys(CATEGORIAS).filter((c) => porCat[c]).map((c) => `
      <div class="small" style="margin:6px 0">${esc(CATEGORIAS[c])} <span class="muted">· ${porCat[c]}</span><div class="bar"><i style="width:${(porCat[c] / max) * 100}%"></i></div></div>`).join("")}</div>` : ""}
    <div class="chips">${["todas", ...Object.keys(CATEGORIAS)].map((c) => `<button data-c="${c}" class="${c === filtroCategoria ? "on" : ""}">${c === "todas" ? "Todas" : esc(CATEGORIAS[c])}</button>`).join("")}</div>
    ${lista.length ? `<div class="card"><ul class="list">${lista.map((e) => {
      const t = tarjetaDe(e.id);
      return `<li class="item">${htmlError(e)}
        <div class="small muted">${e.veces > 1 ? `Repetido ${e.veces}× · ` : ""}Próximo repaso: ${t ? fechaBonita(t.proxima) : "—"}
        · <a href="#" data-borrar="${esc(e.id)}">quitar</a></div></li>`;
    }).join("")}</ul></div>` : `<div class="card muted">Todavía no hay errores aquí. Haz una misión y tus errores aparecerán como material de repaso.</div>`}`;
  $$("[data-c]", root).forEach((b) => b.addEventListener("click", () => { filtroCategoria = b.dataset.c; pantallas.errores(root); }));
  $$("[data-borrar]", root).forEach((a) => dobleToque(a, "¿seguro? toca otra vez", () => {
    S.errores = S.errores.filter((e) => e.id !== a.dataset.borrar);
    S.tarjetas = S.tarjetas.filter((t) => t.errorId !== a.dataset.borrar);
    guardar(); pantallas.errores(root);
  }));
};

let A = { fase: "escribir", mensaje: "", texto: "", error: null, intentoId: null };
pantallas.ahora = (root) => {
  if (A.fase === "resultado") {
    const i = S.intentos.find((x) => x.id === A.intentoId);
    root.innerHTML = `${htmlCorreccion(resultadoDeIntento(i), { modoAhora: true })}
      <p class="small muted">${i.nuevosIds.length} error${i.nuevosIds.length === 1 ? "" : "es"} nuevo${i.nuevosIds.length === 1 ? "" : "s"} guardado${i.nuevosIds.length === 1 ? "" : "s"} en tu banco.</p>
      <button class="btn sec" id="otro">Contestar otro mensaje</button>`;
    enlazarCopiar(root);
    $("#otro", root).addEventListener("click", () => { A = { fase: "escribir", mensaje: "", texto: "", error: null, intentoId: null }; pantallas.ahora(root); });
    return;
  }
  root.innerHTML = `
    <p class="muted small">Pega el mensaje real que tienes que contestar, escribe tu respuesta en alemán y te la devuelvo corregida y lista para enviar.</p>
    <label for="msj">Mensaje recibido</label>
    <textarea id="msj" class="de" lang="de" style="min-height:120px" placeholder="Pega aquí el correo o mensaje…">${esc(A.mensaje)}</textarea>
    <label for="resp-ahora">Tu respuesta en alemán</label>
    <textarea id="resp-ahora" class="de" lang="de" spellcheck="false" placeholder="Escríbela tú primero, aunque salga mal…">${esc(A.texto)}</textarea>
    ${A.error ? cajaError(A.error) : ""}
    ${A.fase === "cargando" ? cargando("Corrigiendo… suele tardar 10–30 segundos") : `<button class="btn" id="go">Corregir y preparar</button>`}`;
  $("#msj", root).addEventListener("input", (ev) => (A.mensaje = ev.target.value));
  $("#resp-ahora", root).addEventListener("input", (ev) => (A.texto = ev.target.value));
  $("#go", root)?.addEventListener("click", async () => {
    if (contarPalabras(A.texto) < 2) { A.error = "Escribe tu respuesta primero (aunque sea imperfecta)."; return pantallas.ahora(root); }
    A.fase = "cargando"; A.error = null; pantallas.ahora(root);
    try {
      const resultado = await corregirConClaude({ modo: "ahora", mensaje: A.mensaje, texto: A.texto });
      const i = guardarIntento({ modo: "ahora", texto: A.texto, mensaje: A.mensaje, resultado });
      A.fase = "resultado"; A.intentoId = i.id;
    } catch (err) { A.fase = "escribir"; A.error = err.message; }
    if (ruta === "ahora") { pantallas.ahora($("#app")); scrollTo(0, 0); }
  });
};

pantallas.ajustes = (root) => {
  const enLaNube = DB && listoDatos;
  root.innerHTML = `
    <div class="card">
      <h3>Tus datos</h3>
      <p class="small">${enLaNube ? "Se guardan en la base de datos privada de esta app, ligada a tu cuenta de Claude: los ves igual desde el móvil y el ordenador, y solo tú puedes leerlos." : "Ahora mismo solo se guardan en este dispositivo. Abre la app con tu sesión de claude.ai iniciada para guardarlos en tu cuenta."}</p>
      <p class="small muted">${S.intentos.length} intentos · ${S.errores.length} errores · ${S.tarjetas.length} tarjetas.</p>
      <button class="btn ghost" id="reset">Borrar todo</button>
    </div>
    <div class="card">
      <h3>Correcciones con Claude</h3>
      <p class="small">Las correcciones usan tu propia cuenta de Claude, sin API key. La primera vez la app te pide permiso: acéptalo.</p>
    </div>
    <div class="card">
      <h3>En el móvil</h3>
      <p class="small">Abre el enlace de esta app en el móvil con tu sesión de claude.ai iniciada. En Safari: Compartir → «Añadir a pantalla de inicio». En Chrome: menú ⋮ → «Añadir a pantalla de inicio».</p>
    </div>`;
  dobleToque($("#reset", root), "Toca otra vez: se borra todo y no se puede deshacer", () => {
    S = estadoNuevo(); M = null; guardar(); render(); aviso("Datos borrados");
  });
};

// ───────────────────────── router ─────────────────────────
const TITULOS = { hoy: "Hoy", misiones: "Misiones", mision: "Misión", errores: "Banco de errores", ahora: "Contestar ya", ajustes: "Ajustes" };
let ruta = ["hoy", "misiones", "errores", "ahora", "ajustes"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "hoy";
let rutaArg = null;

function ir(r, arg = null) {
  if (ruta === "mision" && (r !== "mision" || arg !== rutaArg)) M = null;
  ruta = r; rutaArg = arg;
  render();
  scrollTo(0, 0);
}

function render() {
  if (!pantallas[ruta]) ruta = "hoy";
  $("#titulo").textContent = TITULOS[ruta];
  const tab = ruta === "mision" ? "misiones" : ruta;
  $$(".tabs [data-go]").forEach((a) => a.classList.toggle("on", a.dataset.go === tab));
  $("#fab").hidden = ruta === "ahora";
  pantallas[ruta]($("#app"), rutaArg);
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-go]");
  if (!el) return;
  ev.preventDefault();
  const [r, arg] = el.dataset.go.split("|");
  ir(r, arg ? decodeURIComponent(arg) : null);
});

document.addEventListener("visibilitychange", () => {
  // si la app seguía abierta desde ayer, empieza la sesión del nuevo día
  if (document.visibilityState === "visible" && ruta === "hoy" && S.sesion && S.sesion.fecha !== hoy()) render();
});

render();
iniciarDatos();
