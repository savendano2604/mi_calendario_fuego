"""
descargar_departamentos.py — Guarda el mapa de departamentos de Colombia dentro del proyecto

Uso (desde la carpeta procesamiento):
    python descargar_departamentos.py ../datos/departamentos.js

    o, si ya descargaste un archivo .geojson a mano:
    python descargar_departamentos.py ../datos/departamentos.js mi_archivo.geojson

Prueba varias fuentes públicas hasta que una funcione, revisa que el archivo
tenga los ~33 departamentos y lo guarda como datos/departamentos.js.
Así la página ya no depende de internet para dibujar los departamentos.
"""
import json
import sys
import urllib.request

FUENTES = [
    # geoBoundaries (William & Mary geoLab): la API devuelve el enlace al GeoJSON simplificado
    ("geoBoundaries", "https://www.geoboundaries.org/api/current/gbOpen/COL/ADM1/"),
    # GeoJSON clásico de departamentos (John Guerra, usado en muchos mapas de Colombia)
    ("Gist John Guerra", "https://gist.githubusercontent.com/john-guerra/43c7656821069d00dcbc/raw/Colombia.geo.json"),
]


def bajar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FLARE-SpaceApps/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def es_valido(gj):
    return isinstance(gj, dict) and gj.get("type") == "FeatureCollection" and 25 <= len(gj.get("features", [])) <= 40


def obtener():
    for nombre, url in FUENTES:
        try:
            print(f"Probando {nombre}…")
            datos = bajar(url)
            if nombre == "geoBoundaries":
                datos = bajar(datos["simplifiedGeometryGeoJSON"])
            if es_valido(datos):
                print(f"  ✔ Funcionó: {len(datos['features'])} departamentos")
                return datos
            print("  ✘ El archivo no parece de departamentos de Colombia")
        except Exception as e:
            print(f"  ✘ No funcionó ({e})")
    return None


def main(salida, archivo_local=None):
    if archivo_local:
        with open(archivo_local, encoding="utf-8") as f:
            datos = json.load(f)
        if not es_valido(datos):
            sys.exit("El archivo no parece un GeoJSON con los departamentos de Colombia.")
    else:
        datos = obtener()
        if datos is None:
            sys.exit("No se pudo descargar de ninguna fuente. Descarga un .geojson a mano y pásalo como segundo argumento.")

    # Redondear coordenadas a 4 decimales (~10 m) para que el archivo pese menos
    def redondear(c):
        return [redondear(x) for x in c] if isinstance(c[0], list) else [round(c[0], 4), round(c[1], 4)]
    for f in datos["features"]:
        f["geometry"]["coordinates"] = redondear(f["geometry"]["coordinates"])

    with open(salida, "w", encoding="utf-8") as f:
        f.write("// Departamentos de Colombia — generado por descargar_departamentos.py\n")
        f.write("const DEPARTAMENTOS = ")
        json.dump(datos, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print(f"Listo: {salida}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
