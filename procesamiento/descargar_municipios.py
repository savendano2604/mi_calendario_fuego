"""
descargar_municipios.py — Guarda el mapa de municipios de Colombia dentro del proyecto

Uso (desde la carpeta procesamiento):
    python descargar_municipios.py ../datos/municipios.js

    o, si ya descargaste un archivo .geojson de municipios a mano:
    python descargar_municipios.py ../datos/municipios.js mi_archivo.geojson

Fuente: geoBoundaries (William & Mary geoLab), nivel ADM2 = municipios de Colombia.
El programa revisa que vengan ~1.100 municipios, simplifica un poco los bordes
para que el archivo no pese tanto y lo guarda como datos/municipios.js.
"""
import json
import sys
import urllib.request

API = "https://www.geoboundaries.org/api/current/gbOpen/COL/ADM2/"


def bajar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FLARE-SpaceApps/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def es_valido(gj):
    return isinstance(gj, dict) and gj.get("type") == "FeatureCollection" and 900 <= len(gj.get("features", [])) <= 1300


def simplificar_anillo(anillo):
    """Redondea a 3 decimales (~100 m) y quita puntos repetidos seguidos."""
    salida = []
    for x, y in anillo:
        p = [round(x, 3), round(y, 3)]
        if not salida or salida[-1] != p:
            salida.append(p)
    if len(salida) < 4:   # anillo muy pequeño: se deja con 4 decimales
        salida = [[round(x, 4), round(y, 4)] for x, y in anillo]
    if salida[0] != salida[-1]:
        salida.append(salida[0])
    return salida


def simplificar(geom):
    if geom["type"] == "Polygon":
        geom["coordinates"] = [simplificar_anillo(a) for a in geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        geom["coordinates"] = [[simplificar_anillo(a) for a in p] for p in geom["coordinates"]]


def main(salida, archivo_local=None):
    if archivo_local:
        with open(archivo_local, encoding="utf-8") as f:
            datos = json.load(f)
    else:
        print("Descargando municipios de geoBoundaries… (puede tardar un minuto)")
        try:
            info = bajar(API)
            datos = bajar(info["simplifiedGeometryGeoJSON"])
        except Exception as e:
            sys.exit(f"No se pudo descargar ({e}). Descarga un .geojson de municipios a mano y pásalo como segundo argumento.")
    if not es_valido(datos):
        sys.exit("El archivo no parece un GeoJSON con los municipios de Colombia (se esperaban ~1.100).")

    for f in datos["features"]:
        simplificar(f["geometry"])
        p = f.get("properties", {})
        f["properties"] = {"nombre": p.get("shapeName") or p.get("MPIO_CNMBR") or p.get("NOMBRE_MPI") or p.get("name") or "Sin nombre"}

    with open(salida, "w", encoding="utf-8") as f:
        f.write("// Municipios de Colombia — generado por descargar_municipios.py\n")
        f.write("const MUNICIPIOS = ")
        json.dump(datos, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"✔ {len(datos['features'])} municipios guardados en {salida}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
