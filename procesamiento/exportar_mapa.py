"""
exportar_mapa.py — Datos detallados para el mapa de calor (FLARE)

Uso:
    python exportar_mapa.py <carpeta_modis> <carpeta_viirs> <salida_mapa.js> [carpeta_noaa20]

Si se da la carpeta de NOAA-20, sus días posteriores al último día de Suomi NPP se agregan
ajustados a la escala de Suomi NPP (focos / K_N20).

Crea un archivo con los focos de fuego ARMONIZADOS en celdas de 0.1° (~11 km),
separados por año y por mes. Así la página puede dibujar un mapa de calor suave
y filtrar por periodo (por ejemplo, desde el calendario).

Formato:  const DATOS_MAPA = {
            meta: {...},
            celdas: [[lat, lon, [[año, mes, focos, crudo], ...]], ...]
          }
  - año: índice desde 2001 (0 = 2001)
  - mes: 1 a 12
  - focos: focos armonizados (equivalente VIIRS)
  - crudo: focos SIN armonizar (como los ve cada satélite), para el botón "antes/después"
"""
import json
import sys

import procesar_datos as base


def main(carpeta_modis, carpeta_viirs, salida, carpeta_n20=None):
    md = base.cargar(carpeta_modis, "modis")
    vd = base.cargar(carpeta_viirs, "viirs")
    m = base.celdas_dia(md)
    mt = base.celdas_dia(md[md.satellite == "Terra"])
    v = base.celdas_dia(vd)
    ultima = max(md.fecha.max(), vd.fecha.max()).date()

    # Mismos factores que procesar_datos.py
    kreg, knac = base.factores_viirs_modis(m, v, base.AÑOS_CALIB)
    kterra = base.factor_terra(m, mt, range(2003, 2022))

    pre = m[m.fecha < base.INICIO_VIIRS].copy()
    pre["focos"] = base.aplicar(pre, kreg, knac, kterra)
    pre["crudo"] = 1.0
    pos = v[v.fecha >= base.INICIO_VIIRS].copy()
    pos["focos"] = 1.0
    pos["crudo"] = 1.0
    partes = [pre, pos]
    meta_n20 = {}
    if carpeta_n20:
        nd = base.cargar(carpeta_n20, "n20")
        fij = base.FIJAS.get("modis", set()) | base.FIJAS.get("viirs", set())
        clave = list(zip((nd.latitude / 0.01).round().astype(int), (nd.longitude / 0.01).round().astype(int)))
        nd = nd[[k not in fij for k in clave]]
        nd = nd[nd.fecha > vd.fecha.max()]          # solo después del último día de Suomi NPP
        if len(nd):
            n = base.celdas_dia(nd)
            n["focos"] = 1.0 / base.K_N20
            n["crudo"] = 1.0
            partes.append(n)
            ultima = max(ultima, nd.fecha.max().date())
            meta_n20 = {"n20": {"factor": base.K_N20, "desde": str(n.fecha.min().date())}}
    todo = base.pd.concat(partes)

    g = todo.groupby(["cx", "cy", "año", "mes"])[["focos", "crudo"]].sum().reset_index()
    celdas = []
    for (cx, cy), grupo in g.groupby(["cx", "cy"]):
        lat = round((cy + 0.5) * base.CELDA, 2)
        lon = round((cx + 0.5) * base.CELDA, 2)
        serie = [[int(r.año - base.AÑO_INICIO), int(r.mes), round(float(r.focos), 1), int(r.crudo)] for r in grupo.itertuples()]
        celdas.append([lat, lon, serie])

    # Fuentes fijas (mecheros, industria): la página las usa para limpiar las actualizaciones futuras
    fijas = sorted(base.FIJAS.get("modis", set()) | base.FIJAS.get("viirs", set()) | base.FIJAS.get("n20", set()))
    meta = {"añoInicio": base.AÑO_INICIO, "añoFin": ultima.year, "ultimaFecha": str(ultima),
            "celdaGrados": base.CELDA, "fijas": [[int(a), int(b)] for a, b in fijas],
            "fuente": "Datos originales de FLARE (NASA FIRMS)", **meta_n20}
    with open(salida, "w", encoding="utf-8") as f:
        f.write("// Archivo generado por exportar_mapa.py — no editar a mano\n")
        f.write("const DATOS_MAPA = ")
        json.dump({"meta": meta, "celdas": celdas}, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"Listo: {salida} ({len(celdas)} celdas de 11 km)")


if __name__ == "__main__":
    main(*sys.argv[1:5])
