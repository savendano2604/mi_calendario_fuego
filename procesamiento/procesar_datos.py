"""
procesar_datos.py — Calendario de Fuego (NASA Space Apps 2026)
================================================================
Convierte los CSV de NASA FIRMS (MODIS y VIIRS) en un archivo pequeño
(datos.js) que la página web puede leer.

Uso:
    python procesar_datos.py <carpeta_modis> <carpeta_viirs> <salida_datos.js>

Cada carpeta es la que viene dentro del ZIP que manda FIRMS
(contiene fire_archive_*.csv y fire_nrt_*.csv).

MÉTODO (resumen)
----------------
1. Limpieza: solo fuegos de vegetación (type = 0), sin volcanes ni fuentes
   industriales fijas. Se descartan detecciones de baja confianza
   (MODIS < 30 %, VIIRS "l").
2. Unidad común "celda-día con fuego": dividimos el país en cuadros de
   0.1° (~11 km). Si un cuadro tuvo al menos una detección en un día,
   cuenta 1. Así un incendio grande no cuenta 50 veces solo porque el
   sensor tenga píxeles más pequeños.
3. Armonización (registro "equivalente VIIRS"):
   a) 2001 a julio 2002 solo existía Terra (Aqua empezó el 4-jul-2002).
      Corregimos con el factor (Terra+Aqua)/Terra medido en 2003-2021.
   b) Antes del 20-ene-2012 solo había MODIS. Corregimos con el factor
      VIIRS/MODIS medido en el periodo en que ambos funcionaron
      (2013-2021), por región de 2°x2° y por mes, con "encogimiento"
      hacia el promedio nacional cuando una región tiene pocos datos.
      No usamos 2022+ para calibrar porque Terra y Aqua empezaron a
      desviarse de su órbita.
4. Incertidumbre: repetimos el cálculo de factores remuestreando los años
   de calibración (bootstrap) y guardamos el rango 10 %–90 %.
5. Validación: calibramos solo con 2013-2017 y "predecimos" VIIRS en
   2018-2021 a partir de MODIS. Comparamos con lo que VIIRS realmente vio.
"""
import json
import sys
from datetime import date

import numpy as np
import pandas as pd

CELDA = 0.1            # tamaño de la celda de conteo (grados)
BLOQUE = 0.5           # tamaño del cuadro que se guarda para la web
REGION = 2.0           # tamaño de la región de calibración
AÑOS_CALIB = range(2013, 2022)
INICIO_VIIRS = "2012-01-20"
INICIO_AQUA = "2002-07-04"
AÑO_INICIO = 2001
SEMANAS = 52
SUAVIZADO = 40         # "pseudo-conteos" para encoger hacia el promedio nacional
rng = np.random.default_rng(42)
FIJAS = {}             # fuentes fijas (industria, mecheros) encontradas por sensor, en claves de 0.01°


# ------------------------------------------------------------------ 1. carga
def cargar(carpeta, sensor):
    archivos = sorted(__import__("glob").glob(f"{carpeta}/fire_*.csv"))
    partes = []
    estaticas = set()
    for f in archivos:
        d = pd.read_csv(f, usecols=lambda c: c in
                        {"latitude", "longitude", "acq_date", "satellite", "confidence", "type"})
        if "type" in d:   # archivo científico: trae la columna type
            fijas = d[d["type"] == 2]
            estaticas |= set(zip((fijas.latitude / 0.01).round().astype(int),
                                 (fijas.longitude / 0.01).round().astype(int)))
            d = d[d["type"] == 0]
        partes.append(d)
    d = pd.concat(partes, ignore_index=True)
    FIJAS[sensor] = estaticas
    # Los datos "NRT" (recientes) no traen type: quitamos los puntos que caen
    # donde el archivo científico marcó fuentes fijas (industria, mecheros).
    clave = list(zip((d.latitude / 0.01).round().astype(int),
                     (d.longitude / 0.01).round().astype(int)))
    d = d[[k not in estaticas for k in clave]]
    if sensor == "modis":
        d = d[pd.to_numeric(d.confidence, errors="coerce") >= 30]
    else:
        d = d[d.confidence.astype(str).str.lower() != "l"]
    d = d.drop(columns=["confidence", "type"], errors="ignore")
    d["fecha"] = pd.to_datetime(d.acq_date)
    return d


def celdas_dia(d):
    """Una fila por (día, celda de 0.1°) con fuego."""
    d = d.assign(cx=np.floor(d.longitude / CELDA).astype(int),
                 cy=np.floor(d.latitude / CELDA).astype(int))
    d = d.drop_duplicates(["fecha", "cx", "cy"])[["fecha", "cx", "cy"]].copy()
    d["año"] = d.fecha.dt.year
    d["mes"] = d.fecha.dt.month
    d["semana"] = np.minimum((d.fecha.dt.dayofyear - 1) // 7, SEMANAS - 1)
    lon = (d.cx + 0.5) * CELDA
    lat = (d.cy + 0.5) * CELDA
    d["bx"] = np.floor(lon / BLOQUE).astype(int)
    d["by"] = np.floor(lat / BLOQUE).astype(int)
    d["rx"] = np.floor(lon / REGION).astype(int)
    d["ry"] = np.floor(lat / REGION).astype(int)
    return d


# ------------------------------------------------------- 3. factores
def factores_viirs_modis(m, v, años):
    """Factor VIIRS/MODIS por (región, mes), encogido hacia el nacional."""
    mm = m[m.año.isin(años)]
    vv = v[v.año.isin(años)]
    M = mm.groupby(["rx", "ry", "mes"]).size()
    V = vv.groupby(["rx", "ry", "mes"]).size()
    Mn = mm.groupby("mes").size()
    Vn = vv.groupby("mes").size()
    nacional = (Vn / Mn).reindex(range(1, 13)).fillna(Vn.sum() / Mn.sum())
    t = pd.concat([M.rename("M"), V.rename("V")], axis=1).fillna(0).reset_index()
    kn = t.mes.map(nacional)
    t["k"] = (t.V + SUAVIZADO * kn) / (t.M + SUAVIZADO)
    return t.set_index(["rx", "ry", "mes"]).k, nacional


def factor_terra(m_todo, m_terra, años):
    A = m_todo[m_todo.año.isin(años)].groupby("mes").size()
    T = m_terra[m_terra.año.isin(años)].groupby("mes").size()
    return (A / T).reindex(range(1, 13))


def aplicar(m, kreg, knac, kterra):
    idx = pd.MultiIndex.from_arrays([m.rx, m.ry, m.mes])
    k = pd.Series(kreg.reindex(idx).values, index=m.index)
    k = k.fillna(m.mes.map(knac))
    solo_terra = m.fecha < INICIO_AQUA
    k = k * np.where(solo_terra, m.mes.map(kterra), 1.0)
    return k


def main(carpeta_modis, carpeta_viirs, salida):
    print("Cargando datos…")
    md = cargar(carpeta_modis, "modis")
    vd = cargar(carpeta_viirs, "viirs")
    m = celdas_dia(md)
    mt = celdas_dia(md[md.satellite == "Terra"])
    v = celdas_dia(vd)
    ultima = max(md.fecha.max(), vd.fecha.max()).date()
    print(f"  MODIS: {len(m):,} celdas-día | VIIRS: {len(v):,} celdas-día | hasta {ultima}")

    # ---- factores con todos los años de calibración
    kreg, knac = factores_viirs_modis(m, v, AÑOS_CALIB)
    kterra = factor_terra(m, mt, range(2003, 2022))
    print("  Factor nacional VIIRS/MODIS por mes:", knac.round(2).to_dict())
    print("  Factor Terra+Aqua / Terra por mes:", kterra.round(2).to_dict())

    # ---- incertidumbre (bootstrap de años)
    años = list(AÑOS_CALIB)
    pre = m[m.fecha < INICIO_VIIRS].copy()
    boot = []
    for _ in range(60):
        muestra = rng.choice(años, size=len(años), replace=True)
        mm = pd.concat([m[m.año == a] for a in muestra])
        vv = pd.concat([v[v.año == a] for a in muestra])
        kr, kn = factores_viirs_modis(mm, vv, set(muestra))
        mtt = pd.concat([mt[mt.año == a] for a in muestra])
        mta = pd.concat([m[m.año == a] for a in muestra])
        kt = factor_terra(mta, mtt, set(muestra))
        k = aplicar(pre, kr, kn, kt)
        boot.append(pre.assign(k=k).groupby(["bx", "by", "año"]).k.sum())
    boot = pd.concat(boot, axis=1)
    banda = pd.DataFrame({"lo": boot.quantile(0.1, axis=1), "hi": boot.quantile(0.9, axis=1)})

    # ---- validación: calibrar 2013-2017, probar 2018-2021
    kr, kn = factores_viirs_modis(m, v, range(2013, 2018))
    prueba = m[m.año.between(2018, 2021)].copy()
    prueba["k"] = aplicar(prueba, kr, kn, kterra)
    pred = prueba.groupby(["bx", "by", "año"]).k.sum()
    real = v[v.año.between(2018, 2021)].groupby(["bx", "by", "año"]).size()
    crudo = prueba.groupby(["bx", "by", "año"]).size()
    t = pd.concat([real.rename("real"), pred.rename("pred"), crudo.rename("crudo")], axis=1).fillna(0)
    t = t[t.real >= 20]   # cuadros con actividad apreciable
    err_arm = float(np.median(np.abs(t.pred - t.real) / t.real))
    err_cru = float(np.median(np.abs(t.crudo - t.real) / t.real))
    nac = t.groupby(level=2).sum()
    err_nac = float(np.mean(np.abs(nac.pred - nac.real) / nac.real))
    corr = float(np.corrcoef(np.log1p(t.pred), np.log1p(t.real))[0, 1])
    print(f"  Validación 2018-2021: error mediano por cuadro armonizado {err_arm:.0%} "
          f"vs sin armonizar {err_cru:.0%}; error nacional anual {err_nac:.1%}; r={corr:.2f}")

    # ---- serie final por cuadro de 0.5°, día a día
    pre = m[m.fecha < INICIO_VIIRS].copy()
    pre["arm"] = aplicar(pre, kreg, knac, kterra)
    pre["cru"] = 1.0
    pos = v[v.fecha >= INICIO_VIIRS].copy()
    pos["arm"] = 1.0
    pos["cru"] = 1.0
    todo = pd.concat([pre, pos])
    sem = todo.groupby(["bx", "by", "año", "semana"])[["cru", "arm"]].sum().reset_index()
    # En 2012 el año es mixto: a la banda (parte MODIS) le sumamos la parte VIIRS
    parte_viirs = pos.groupby(["bx", "by", "año"]).size()
    v2012 = parte_viirs[parte_viirs.index.get_level_values(2) == 2012]
    banda = banda.reindex(banda.index.union(v2012.index)).fillna(0)
    extra = parte_viirs.reindex(banda.index).fillna(0)
    banda = banda.add(extra, axis=0)

    bloques = {}
    for (bx, by), g in sem.groupby(["bx", "by"]):
        serie = [[int(r.año - AÑO_INICIO), int(r.semana), round(float(r.cru), 1), round(float(r.arm), 1)]
                 for r in g.itertuples()]
        bloques[(bx, by)] = {"la": round((by + 0.5) * BLOQUE, 2), "lo": round((bx + 0.5) * BLOQUE, 2), "s": serie}
    for (bx, by, año), r in banda.iterrows():
        if (bx, by) in bloques:
            bloques[(bx, by)].setdefault("b", []).append(
                [int(año - AÑO_INICIO), round(float(r.lo), 1), round(float(r.hi), 1)])

    meta = {
        "añoInicio": AÑO_INICIO,
        "añoFin": ultima.year,
        "ultimaFecha": str(ultima),
        "semanaActual": int(min((ultima.timetuple().tm_yday - 1) // 7, SEMANAS - 1)),
        "inicioViirs": INICIO_VIIRS,
        "inicioAqua": INICIO_AQUA,
        "celdaKm": 11,
        "bloque": BLOQUE,
        "factorNacional": round(float(knac.mean()), 2),
        "factorTerra": round(float(kterra.mean()), 2),
        "validacion": {"errorArmonizado": round(err_arm, 3), "errorCrudo": round(err_cru, 3),
                       "errorNacional": round(err_nac, 3), "correlacion": round(corr, 3)},
        "generado": str(date.today()),
    }
    with open(salida, "w", encoding="utf-8") as f:
        f.write("// Archivo generado por procesar_datos.py — no editar a mano\n")
        f.write("const DATOS = ")
        json.dump({"meta": meta, "bloques": list(bloques.values())}, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"Listo: {salida} ({len(bloques)} cuadros)")


if __name__ == "__main__":
    main(*sys.argv[1:4])
