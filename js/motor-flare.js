// =====================================================================
// MOTOR DE PROCESAMIENTO DE FLARE (JavaScript)
// Traducción de procesamiento/procesar_datos.py + exportar_mapa.py para que
// la página pueda procesar los archivos de la NASA sin Python ni servidor.
// Corre dentro de un Web Worker (un hilo aparte) para no congelar la página.
//
// Modos:
//   "completo"   → recalcula todo desde cero (necesita MODIS 2001–2021 y VIIRS 2013–2021)
//   "actualizar" → agrega a los datos actuales los días de VIIRS posteriores a la última fecha
//   "auto"       → elige solo según los archivos que se suban
// =====================================================================
const MOTOR = (() => {
  const CELDA = 0.1, REGION = 2.0, BLOQUE = 0.5, SUAVIZADO = 40;
  const AÑO_INICIO = 2001;
  const DIA = 864e5;
  const diaDe = txt => {                                  // "2026-10-24" → días desde 1970
    const y = +txt.slice(0, 4), m = +txt.slice(5, 7), d = +txt.slice(8, 10);
    return Number.isFinite(y + m + d) && y > 1990 ? Math.round(Date.UTC(y, m - 1, d) / DIA) : NaN;
  };
  const textoDe = dia => new Date(dia * DIA).toISOString().slice(0, 10);
  // Redondeo "al par" (como numpy/Python) para que las fuentes fijas coincidan exactamente
  const redondeoPar = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
  const claveFija = (lat, lon) => redondeoPar(lat / 0.01) + "," + redondeoPar(lon / 0.01);
  const D_INICIO = diaDe("2001-01-01"), D_AQUA = diaDe("2002-07-04"), D_VIIRS = diaDe("2012-01-20");
  const cacheFecha = new Map();
  const añoMes = dia => {
    let r = cacheFecha.get(dia);
    if (!r) { const f = new Date(dia * DIA); r = [f.getUTCFullYear(), f.getUTCMonth() + 1]; cacheFecha.set(dia, r); }
    return r;
  };

  // ¿Qué satélite es esta fila? (las descargas de FIRMS no siempre nombran igual las columnas)
  function sensorDe(sat) {
    const s = String(sat || "").trim().toUpperCase();
    if (s === "TERRA" || s === "T") return "terra";
    if (s === "AQUA" || s === "A") return "aqua";
    if (["SNPP", "N", "NPP", "SUOMI NPP", "S-NPP", "SUOMI-NPP", "SUOMI_NPP"].includes(s)) return "viirs";
    return "otro";                                         // NOAA-20, NOAA-21, Landsat… (no se usan)
  }

  // ---------- 1. Leer las filas de un CSV ----------
  async function leerCSV(archivo, almacen, avisar) {
    let cab = null, n = 0;
    for await (const linea of archivo.lineas()) {
      if (!linea) continue;
      const c = linea.split(",");
      if (!cab) {
        cab = {};
        c.forEach((nombre, i) => cab[nombre.trim().toLowerCase()] = i);
        for (const req of ["latitude", "longitude", "acq_date", "satellite", "confidence"])
          if (!(req in cab)) throw new Error(`El archivo "${archivo.nombre}" no parece de NASA FIRMS (falta la columna "${req}").`);
        continue;
      }
      n++;
      if (n % 200000 === 0) avisar(n);
      const sensor = sensorDe(c[cab.satellite]);
      const lat = +c[cab.latitude], lon = +c[cab.longitude], dia = diaDe(c[cab.acq_date]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dia)) { almacen.malas++; continue; }
      if (sensor === "otro") { almacen.otros++; continue; }
      const s = sensor === "viirs" ? almacen.viirs : almacen.modis;
      // Archivo científico (trae "type"): 2 = fuente fija; solo se usan fuegos de vegetación (0)
      if ("type" in cab) {
        const tipo = c[cab.type].trim();
        if (tipo === "2") s.fijas.add(claveFija(lat, lon));
        if (tipo !== "0") continue;
      }
      // Confianza: MODIS ≥ 30 %, VIIRS distinto de "l" (baja)
      const conf = c[cab.confidence].trim();
      if (sensor === "viirs") { if (conf.toLowerCase() === "l") continue; }
      else { const v = parseFloat(conf); if (!(v >= 30)) continue; }
      s.dia.push(dia); s.lat.push(lat); s.lon.push(lon); s.terra.push(sensor === "terra" ? 1 : 0);
      s.min = Math.min(s.min, dia); s.max = Math.max(s.max, dia);
    }
    return n;
  }

  // ---------- 2. Celdas-día con fuego (una por día y cuadro de 0.1°) ----------
  function celdasDia(s, fijasExtra, soloTerra = false, desde = -Infinity) {
    const fijas = fijasExtra ? new Set([...s.fijas, ...fijasExtra]) : s.fijas;
    const vistos = new Set(), out = { dia: [], cx: [], cy: [] };
    for (let i = 0; i < s.dia.length; i++) {
      if (soloTerra && !s.terra[i]) continue;
      const dia = s.dia[i];
      if (dia < D_INICIO || dia <= desde) continue;
      const lat = s.lat[i], lon = s.lon[i];
      if (fijas.size && fijas.has(claveFija(lat, lon))) continue;
      const cx = Math.floor(lon / CELDA), cy = Math.floor(lat / CELDA);
      const clave = dia * 1e6 + (cx + 1000) * 1000 + (cy + 500);
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      out.dia.push(dia); out.cx.push(cx); out.cy.push(cy);
    }
    return out;
  }
  const regionDe = (cx, cy) => Math.floor((cx + 0.5) * CELDA / REGION) + "," + Math.floor((cy + 0.5) * CELDA / REGION);

  // ---------- 3. Factores de armonización ----------
  function factoresViirsModis(m, v, años) {
    const contar = (cd) => {
      const reg = new Map(), nac = new Array(13).fill(0);
      for (let i = 0; i < cd.dia.length; i++) {
        const [a, mes] = añoMes(cd.dia[i]);
        if (!años.has(a)) continue;
        const k = regionDe(cd.cx[i], cd.cy[i]) + "," + mes;
        reg.set(k, (reg.get(k) || 0) + 1);
        nac[mes]++;
      }
      return { reg, nac };
    };
    const M = contar(m), V = contar(v);
    const totM = M.nac.reduce((a, b) => a + b, 0), totV = V.nac.reduce((a, b) => a + b, 0);
    const nacional = M.nac.map((x, mes) => mes === 0 ? 0 : (x > 0 ? V.nac[mes] / x : (totM ? totV / totM : 1)));
    const kreg = new Map();
    for (const k of new Set([...M.reg.keys(), ...V.reg.keys()])) {
      const mes = +k.split(",")[2];
      kreg.set(k, ((V.reg.get(k) || 0) + SUAVIZADO * nacional[mes]) / ((M.reg.get(k) || 0) + SUAVIZADO));
    }
    return { kreg, nacional };
  }
  function factorTerra(todo, terra, años) {
    const contar = cd => { const n = new Array(13).fill(0); for (let i = 0; i < cd.dia.length; i++) { const [a, mes] = añoMes(cd.dia[i]); if (años.has(a)) n[mes]++; } return n; };
    const A = contar(todo), T = contar(terra);
    return A.map((x, mes) => mes === 0 ? 0 : (T[mes] ? x / T[mes] : 1));
  }
  function factorDe(cx, cy, dia, f, kterra) {
    const [, mes] = añoMes(dia);
    let k = f.kreg.get(regionDe(cx, cy) + "," + mes);
    if (k === undefined) k = f.nacional[mes];
    return dia < D_AQUA ? k * kterra[mes] : k;
  }
  const rango = (a, b) => new Set(Array.from({ length: b - a + 1 }, (_, i) => a + i));

  // ---------- 4. Validación: calibrar 2013–2017 y "adivinar" 2018–2021 ----------
  function validar(m, v, kterra) {
    const f = factoresViirsModis(m, v, rango(2013, 2017));
    const pred = new Map(), crudo = new Map(), real = new Map();
    const clave = (cx, cy, a) => Math.floor((cx + 0.5) * CELDA / BLOQUE) + "," + Math.floor((cy + 0.5) * CELDA / BLOQUE) + "," + a;
    for (let i = 0; i < m.dia.length; i++) {
      const [a] = añoMes(m.dia[i]); if (a < 2018 || a > 2021) continue;
      const k = clave(m.cx[i], m.cy[i], a), x = factorDe(m.cx[i], m.cy[i], m.dia[i], f, kterra);
      pred.set(k, (pred.get(k) || 0) + x); crudo.set(k, (crudo.get(k) || 0) + 1);
    }
    for (let i = 0; i < v.dia.length; i++) {
      const [a] = añoMes(v.dia[i]); if (a < 2018 || a > 2021) continue;
      const k = clave(v.cx[i], v.cy[i], a);
      real.set(k, (real.get(k) || 0) + 1);
    }
    const errA = [], errC = [];
    for (const [k, r] of real) if (r >= 20) { errA.push(Math.abs((pred.get(k) || 0) - r) / r); errC.push(Math.abs((crudo.get(k) || 0) - r) / r); }
    const mediana = arr => { const o = arr.sort((a, b) => a - b); return o.length ? o[Math.floor((o.length - 1) / 2)] * 0.5 + o[Math.ceil((o.length - 1) / 2)] * 0.5 : NaN; };
    // Error nacional: suma por año de los cuadros con actividad apreciable (igual que en Python)
    const sumP = {}, sumR = {};
    for (const [k, r] of real) if (r >= 20) { const a = k.split(",")[2]; sumR[a] = (sumR[a] || 0) + r; sumP[a] = (sumP[a] || 0) + (pred.get(k) || 0); }
    const años = Object.keys(sumR);
    const errNac = años.length ? años.reduce((s, a) => s + Math.abs(sumP[a] - sumR[a]) / sumR[a], 0) / años.length : NaN;
    return { errorArmonizado: mediana(errA), errorCrudo: mediana(errC), errorNacional: errNac };
  }

  // ---------- 5. Agrupar en celdas × (año, mes) ----------
  function agregar(registros) {
    // registros: lista de {cd, peso: (i) => [focos, crudo]}
    const celdas = new Map();
    for (const { cd, peso } of registros) {
      for (let i = 0; i < cd.dia.length; i++) {
        const [a, mes] = añoMes(cd.dia[i]);
        const kc = cd.cx[i] + "," + cd.cy[i];
        let c = celdas.get(kc);
        if (!c) { c = { cx: cd.cx[i], cy: cd.cy[i], s: new Map() }; celdas.set(kc, c); }
        const km = (a - AÑO_INICIO) * 12 + mes - 1;
        const [f, cr] = peso(i);
        const e = c.s.get(km);
        if (e) { e[0] += f; e[1] += cr; } else c.s.set(km, [f, cr]);
      }
    }
    return celdas;
  }
  const redondear = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  function aSalida(celdas) {
    return [...celdas.values()]
      .sort((p, q) => p.cx - q.cx || p.cy - q.cy)
      .map(c => [redondear((c.cy + 0.5) * CELDA, 2), redondear((c.cx + 0.5) * CELDA, 2),
        [...c.s.entries()].sort((p, q) => p[0] - q[0]).map(([km, [f, cr]]) => [Math.floor(km / 12), km % 12 + 1, redondear(f, 1), Math.round(cr)])]);
  }

  // ---------- 6. Modo COMPLETO ----------
  function completo(alm, avisar) {
    avisar("contar", "Contando focos (celdas de 11 km por día)…");
    const m = celdasDia(alm.modis), mt = celdasDia(alm.modis, null, true), v = celdasDia(alm.viirs);
    avisar("armonizar", "Calculando factores de armonización por región y mes…");
    const f = factoresViirsModis(m, v, rango(2013, 2021));
    const kterra = factorTerra(m, mt, rango(2003, 2021));
    avisar("validar", "Validando: calibrar 2013–2017 y predecir 2018–2021…");
    const val = validar(m, v, kterra);
    avisar("agrupar", "Armando el archivo para el mapa…");
    const pre = { dia: [], cx: [], cy: [] };
    for (let i = 0; i < m.dia.length; i++) if (m.dia[i] < D_VIIRS) { pre.dia.push(m.dia[i]); pre.cx.push(m.cx[i]); pre.cy.push(m.cy[i]); }
    const pos = { dia: [], cx: [], cy: [] };
    for (let i = 0; i < v.dia.length; i++) if (v.dia[i] >= D_VIIRS) { pos.dia.push(v.dia[i]); pos.cx.push(v.cx[i]); pos.cy.push(v.cy[i]); }
    const celdas = agregar([
      { cd: pre, peso: i => [factorDe(pre.cx[i], pre.cy[i], pre.dia[i], f, kterra), 1] },
      { cd: pos, peso: () => [1, 1] },
    ]);
    const ultimo = Math.max(alm.modis.max, alm.viirs.max);
    const fijas = [...new Set([...alm.modis.fijas, ...alm.viirs.fijas])].map(k => k.split(",").map(Number)).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const mes = f.nacional.slice(1), terra = kterra.slice(1);
    return {
      datos: {
        meta: { añoInicio: AÑO_INICIO, añoFin: añoMes(ultimo)[0], ultimaFecha: textoDe(ultimo), celdaGrados: CELDA, fijas },
        celdas: aSalida(celdas),
      },
      resumen: {
        modo: "completo", celdasDiaModis: m.dia.length, celdasDiaViirs: v.dia.length,
        factorNacional: mes.reduce((a, b) => a + b, 0) / 12, factorTerra: terra.reduce((a, b) => a + b, 0) / 12,
        factoresMes: mes, validacion: val, desde: textoDe(Math.min(alm.modis.min, alm.viirs.min)), hasta: textoDe(ultimo),
      },
    };
  }

  // ---------- 7. Modo ACTUALIZAR (agregar días nuevos de VIIRS) ----------
  function actualizar(alm, base, avisar) {
    if (!base) throw new Error("No hay datos actuales para actualizar.");
    if (!alm.viirs.dia.length) throw new Error("Para actualizar se necesitan archivos de VIIRS (S-NPP). Los datos recientes de FLARE vienen de VIIRS.");
    const ultimoBase = diaDe(base.meta.ultimaFecha);
    const fijasBase = (base.meta.fijas || []).map(([a, b]) => a + "," + b);
    avisar("contar", "Buscando días nuevos después del " + base.meta.ultimaFecha + "…");
    const v = celdasDia(alm.viirs, fijasBase, false, Math.max(ultimoBase, D_VIIRS - 1));
    if (!v.dia.length) {
      return { datos: null, resumen: { modo: "actualizar", sinNovedades: true, ultimaFecha: base.meta.ultimaFecha, hastaArchivo: textoDe(alm.viirs.max) } };
    }
    avisar("agrupar", "Agregando los días nuevos al mapa…");
    // Copiar los datos actuales a una estructura editable
    const celdas = new Map();
    for (const [lat, lon, serie] of base.celdas) {
      const cx = Math.round(lon / CELDA - 0.5), cy = Math.round(lat / CELDA - 0.5);
      const s = new Map();
      for (const [a, mes, f, cr] of serie) s.set(a * 12 + mes - 1, [f, cr ?? f]);
      celdas.set(cx + "," + cy, { cx, cy, s });
    }
    let nuevosFocos = 0;
    for (let i = 0; i < v.dia.length; i++) {
      const [a, mes] = añoMes(v.dia[i]);
      const kc = v.cx[i] + "," + v.cy[i];
      let c = celdas.get(kc);
      if (!c) { c = { cx: v.cx[i], cy: v.cy[i], s: new Map() }; celdas.set(kc, c); }
      const km = (a - AÑO_INICIO) * 12 + mes - 1;
      const e = c.s.get(km);
      if (e) { e[0] += 1; e[1] += 1; } else c.s.set(km, [1, 1]);
      nuevosFocos++;
    }
    const primero = Math.min(...v.dia), ultimo = Math.max(...v.dia);
    const fijas = [...new Set([...fijasBase, ...alm.viirs.fijas])].map(k => k.split(",").map(Number)).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return {
      datos: {
        meta: { ...base.meta, añoFin: añoMes(ultimo)[0], ultimaFecha: textoDe(ultimo), fijas },
        celdas: aSalida(celdas),
      },
      resumen: {
        modo: "actualizar", anterior: base.meta.ultimaFecha, desde: textoDe(primero), hasta: textoDe(ultimo),
        diasNuevos: Math.round(ultimo - Math.max(ultimoBase, primero - 1)), nuevosFocos,
        hueco: primero - ultimoBase > 1 ? { desde: textoDe(ultimoBase + 1), hasta: textoDe(primero - 1) } : null,
      },
    };
  }

  // ---------- 8. Función principal ----------
  async function procesar({ archivos, base, modo = "auto", progreso = () => {} }) {
    const nuevo = () => ({ dia: [], lat: [], lon: [], terra: [], fijas: new Set(), min: Infinity, max: -Infinity });
    const alm = { modis: nuevo(), viirs: nuevo(), otros: 0, malas: 0 };
    let filas = 0;
    for (let i = 0; i < archivos.length; i++) {
      const a = archivos[i];
      progreso({ fase: "leer", texto: `Leyendo ${a.nombre} (${i + 1} de ${archivos.length})…` });
      filas += await leerCSV(a, alm, n => progreso({ fase: "leer", texto: `Leyendo ${a.nombre}: ${n.toLocaleString("es-CO")} filas…` }));
    }
    progreso({ fase: "limpiar", texto: "Limpiando: solo fuegos de vegetación, sin fuentes fijas ni detecciones dudosas…" });
    const cubre = (s, a, b) => s.dia.length && s.min <= diaDe(`${a}-12-31`) && s.max >= diaDe(`${b}-01-01`);
    const puedeCompleto = cubre(alm.modis, 2001, 2021) && cubre(alm.viirs, 2013, 2021) && alm.modis.min <= diaDe("2002-12-31");
    let elegido = modo;
    if (modo === "auto") elegido = puedeCompleto ? "completo" : "actualizar";
    if (elegido === "completo" && !puedeCompleto)
      throw new Error("Para procesar desde cero se necesitan los históricos completos: MODIS desde 2001 y VIIRS desde 2012 (al menos hasta 2021). Con archivos recientes usa \"Actualizar con días nuevos\".");
    const avisar = (fase, texto) => progreso({ fase, texto });
    const r = elegido === "completo" ? completo(alm, avisar) : actualizar(alm, base, avisar);
    r.resumen.filas = filas;
    r.resumen.filasModis = alm.modis.dia.length;
    r.resumen.filasViirs = alm.viirs.dia.length;
    r.resumen.otros = alm.otros;
    r.resumen.malas = alm.malas;
    progreso({ fase: "listo", texto: "¡Listo!" });
    return r;
  }

  // Convierte trozos de bytes (Uint8Array) en líneas de texto, sin cargar todo el archivo a la vez
  async function* lineasDesdeTrozos(trozos) {
    const dec = new TextDecoder("utf-8");
    let resto = "";
    for await (const t of trozos) {
      resto += dec.decode(t, { stream: true });
      const partes = resto.split(/\r?\n/);
      resto = partes.pop();
      for (const p of partes) yield p;
    }
    resto += dec.decode();
    if (resto) yield resto;
  }

  return { procesar, lineasDesdeTrozos, diaDe, textoDe };
})();
if (typeof module !== "undefined") module.exports = MOTOR;
