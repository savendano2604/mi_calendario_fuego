// =====================================================================
// FLARE · Actualización automática diaria (la ejecuta GitHub Actions)
//
// 1. Lee los datos publicados (datos/mapa.js).
// 2. Pide a la API de NASA FIRMS los focos de VIIRS NOAA-20 en Colombia
//    desde el día siguiente a la última fecha hasta AYER (hora UTC).
// 3. Los procesa con js/motor-flare.js, el MISMO motor de la página "Datos"
//    en modo "Agregar días nuevos" (mismo método, mismo factor K_N20).
// 4. Revisa que el resultado sea coherente y solo entonces reescribe datos/mapa.js.
//
// La clave de la NASA llega en la variable de entorno FIRMS_MAP_KEY
// (secreto del repositorio). Nunca se escribe en el código ni en los registros.
//
// Para probarlo en un computador:
//   FIRMS_MAP_KEY=tu_clave node procesamiento/actualizar_automatico.js
// =====================================================================
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RAIZ = path.join(__dirname, "..");
const RUTA_MAPA = path.join(RAIZ, "datos", "mapa.js");
const MOTOR = require(path.join(RAIZ, "js", "motor-flare.js"));

const CLAVE = (process.env.FIRMS_MAP_KEY || "").trim();
const API = (process.env.FIRMS_API || "https://firms.modaps.eosdis.nasa.gov/api").replace(/\/$/, "");
const FUENTE = "VIIRS_NOAA20_NRT";
// Rectángulo que contiene a Colombia (incluye San Andrés); solo se usa si falla la consulta por país
const RECTANGULO = "-82,-4.3,-66.8,13.6";
const MAX_DIAS_POR_CONSULTA = 10;   // límite de la API de FIRMS
const MAX_DIAS_ATRAS = 60;          // si la página lleva más tiempo sin actualizarse, se pide procesar a mano

const { diaDe, textoDe } = MOTOR;
const log = (...x) => console.log(...x);
const ocultar = t => (CLAVE ? String(t).split(CLAVE).join("***") : String(t));

function cargarDatos(ruta) {
  const texto = fs.readFileSync(ruta, "utf8");
  return vm.runInNewContext(texto + "\n;DATOS_MAPA", {}, { timeout: 30000 });
}

async function pedir(url, intentos = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "FLARE (NASA Space Apps 2026)" } });
      const t = await r.text();
      if (!r.ok) { const e = new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`); e.definitivo = r.status >= 400 && r.status < 500 && r.status !== 429; throw e; }
      return t;
    } catch (e) {
      if (i >= intentos || e.definitivo) throw new Error(ocultar(e.message));
      log(`  intento ${i} falló (${ocultar(e.message)}); reintentando…`);
      await new Promise(ok => setTimeout(ok, 5000 * i));
    }
  }
}

const esCSV = t => /^[^\n]*\blatitude\b[^\n]*\blongitude\b/i.test(t.trimStart());

// ---------- Límite de Colombia (para la consulta de respaldo por rectángulo) ----------
function cargarColombia() {
  const texto = fs.readFileSync(path.join(RAIZ, "datos", "departamentos.js"), "utf8");
  const geo = vm.runInNewContext(texto + "\n;DEPARTAMENTOS", {}, { timeout: 30000 });
  const anillos = [];
  for (const f of geo.features) {
    const g = f.geometry;
    const polis = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const p of polis) {
      const ext = p[0];
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of ext) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      anillos.push({ p, x0, x1, y0, y1 });
    }
  }
  const dentroAnillo = (r, x, y) => {
    let d = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
    }
    return d;
  };
  return (lat, lon) => anillos.some(a => lon >= a.x0 && lon <= a.x1 && lat >= a.y0 && lat <= a.y1 &&
    dentroAnillo(a.p[0], lon, lat) && !a.p.slice(1).some(h => dentroAnillo(h, lon, lat)));
}

function recortarAColombia(csv) {
  const dentro = cargarColombia();
  const lineas = csv.split(/\r?\n/).filter(Boolean);
  const cab = lineas[0].split(",").map(s => s.trim().toLowerCase());
  const iLat = cab.indexOf("latitude"), iLon = cab.indexOf("longitude");
  const quedan = lineas.slice(1).filter(l => { const c = l.split(","); return dentro(+c[iLat], +c[iLon]); });
  log(`  recorte a Colombia: ${quedan.length} de ${lineas.length - 1} filas`);
  return [lineas[0], ...quedan].join("\n");
}

// ---------- Descarga de un tramo de días ----------
async function descargarTramo(desde, dias) {
  const fecha = textoDe(desde);
  try {
    const t = await pedir(`${API}/country/csv/${CLAVE}/${FUENTE}/COL/${dias}/${fecha}`);
    if (esCSV(t)) return t;
    throw new Error("respuesta inesperada: " + t.slice(0, 120));
  } catch (e) {
    log(`  la consulta por país no funcionó (${ocultar(e.message)}); uso el rectángulo de Colombia`);
    const t = await pedir(`${API}/area/csv/${CLAVE}/${FUENTE}/${RECTANGULO}/${dias}/${fecha}`);
    if (!esCSV(t)) throw new Error("La API de FIRMS no devolvió un CSV: " + ocultar(t.slice(0, 200)));
    return recortarAColombia(t);
  }
}

// ¿Hasta qué día tiene datos la NASA? (si no se puede saber, se asume que hasta hoy)
async function ultimoDiaDisponible() {
  try {
    const t = await pedir(`${API}/data_availability/csv/${CLAVE}/${FUENTE}`);
    const [cab, fila] = t.trim().split(/\r?\n/);
    const c = cab.split(","), v = fila.split(",");
    const d = diaDe(v[c.indexOf("max_date")] || "");
    return Number.isFinite(d) ? d : Infinity;
  } catch { return Infinity; }
}

// ---------- Revisión del resultado antes de guardar ----------
function revisar(viejo, nuevo) {
  const problemas = [];
  const suma = d => d.celdas.reduce((t, c) => t + c[2].reduce((s, e) => s + e[2], 0), 0);
  const mesClave = (a, m) => (a - 2001) * 12 + m - 1;
  const [ay, am] = viejo.meta.ultimaFecha.split("-").map(Number);
  const primerMesNuevo = mesClave(ay, am);
  const indice = d => {
    const m = new Map();
    for (const [lat, lon, s] of d.celdas) for (const [a, mes, f] of s) m.set(`${lat},${lon},${a},${mes}`, f);
    return m;
  };
  if (!(nuevo.meta.ultimaFecha > viejo.meta.ultimaFecha)) problemas.push("la fecha no avanzó");
  if (nuevo.celdas.length < viejo.celdas.length) problemas.push("hay menos celdas que antes");
  const tv = suma(viejo), tn = suma(nuevo);
  if (tn < tv) problemas.push(`el total bajó (${tv.toFixed(1)} → ${tn.toFixed(1)})`);
  const dias = diaDe(nuevo.meta.ultimaFecha) - diaDe(viejo.meta.ultimaFecha);
  if (tn - tv > 15000 * dias) problemas.push(`demasiados focos nuevos (${(tn - tv).toFixed(0)} en ${dias} días)`);
  const iv = indice(viejo), inu = indice(nuevo);
  let tocados = 0;
  for (const [k, f] of iv) {
    const [, , a, mes] = k.split(",").map(Number);
    if (a * 12 + mes - 1 < primerMesNuevo && inu.get(k) !== f) tocados++;
    if (!inu.has(k)) tocados++;
  }
  if (tocados) problemas.push(`${tocados} datos de meses anteriores cambiaron o desaparecieron`);
  return { problemas, antes: tv, despues: tn };
}

async function main() {
  if (!CLAVE) throw new Error("Falta el secreto FIRMS_MAP_KEY (Settings → Secrets and variables → Actions).");
  const base = cargarDatos(RUTA_MAPA);
  const hoy = diaDe(new Date().toISOString().slice(0, 10));
  const ultimo = diaDe(base.meta.ultimaFecha);
  const disponible = await ultimoDiaDisponible();
  // Solo días completos: hasta ayer, y sin pasar del último día que la NASA ya tiene publicado
  const hasta = Math.min(hoy - 1, disponible - 1);
  log(`Datos publicados hasta ${base.meta.ultimaFecha}.`);
  if (hasta <= ultimo) { log("FLARE ya está al día (o la NASA aún no termina de publicar ayer). No hay nada que hacer."); return; }
  log(`Se buscarán días del ${textoDe(ultimo + 1)} al ${textoDe(hasta)}.`);
  if (hasta - ultimo > MAX_DIAS_ATRAS)
    throw new Error(`Faltan ${hasta - ultimo} días: es mucho para la API. Descarguen el archivo en FIRMS y súbanlo en la página "Datos".`);

  const partes = [];
  for (let d = ultimo + 1; d <= hasta; d += MAX_DIAS_POR_CONSULTA) {
    const n = Math.min(MAX_DIAS_POR_CONSULTA, hasta - d + 1);
    log(`Descargando NOAA-20 del ${textoDe(d)} (${n} día${n > 1 ? "s" : ""})…`);
    const csv = await descargarTramo(d, n);
    const filas = csv.trim().split(/\r?\n/).length - 1;
    log(`  ${filas} filas`);
    partes.push({ nombre: `firms_${FUENTE}_${textoDe(d)}.csv`, csv });
  }
  const archivos = partes.map(p => ({
    nombre: p.nombre,
    async *lineas() { yield* p.csv.split(/\r?\n/); },
  }));

  // Mismo motor y mismo modo que el botón "Agregar días nuevos" de la página.
  // "hoy" = día siguiente a "hasta": así nunca entran días que aún no están completos.
  const r = await MOTOR.procesar({ archivos, base, modo: "actualizar", hoy: hasta + 1, progreso: () => {} });
  const s = r.resumen;
  if (!r.datos) { log(`La NASA aún no tiene focos nuevos para Colombia (archivo hasta ${s.hastaArchivo || "—"}). Se intentará mañana.`); return; }

  const rev = revisar(base, r.datos);
  log(`Resultado: ${s.anterior} → ${s.hasta} · ${s.diasNuevos} día(s) · ${s.nuevosFocos.toFixed(1)} focos nuevos · total ${rev.antes.toFixed(1)} → ${rev.despues.toFixed(1)}`);
  if (s.hueco) log(`Aviso: no hubo focos entre ${s.hueco.desde} y ${s.hueco.hasta}.`);
  if (rev.problemas.length) throw new Error("El resultado no pasó la revisión, no se guarda nada: " + rev.problemas.join("; "));

  const f = new Date();
  r.datos.meta.fuente = `Actualizado automáticamente el ${f.getUTCDate()}/${f.getUTCMonth() + 1}/${f.getUTCFullYear()}`;
  // Mismo formato que el botón "Descargar mapa.js" de la página
  fs.writeFileSync(RUTA_MAPA, "// Archivo generado por FLARE — no editar a mano\nconst DATOS_MAPA = " + JSON.stringify(r.datos) + ";\n");
  log(`Listo: datos/mapa.js ahora llega hasta ${r.datos.meta.ultimaFecha}.`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `hasta=${r.datos.meta.ultimaFecha}\n`);
}

main().catch(e => { console.error("❌ " + ocultar(e.message)); process.exit(1); });
