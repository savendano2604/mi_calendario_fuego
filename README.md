# 🔥 FLARE · Fire Long-term Analysis & Rapid Early-warning

**NASA Space Apps Challenge 2026 · Reto "Harmonization of MODIS and VIIRS Hot Spots"**

🌐 **Página:** https://savendano2604.github.io/mi_calendario_fuego/ · 🇬🇧 [English version](https://savendano2604.github.io/mi_calendario_fuego/?lang=en)

> **EN —** FLARE harmonizes 25 years of NASA FIRMS active-fire records (MODIS 2001+ and VIIRS 2012+) into one comparable burning calendar for Colombia, by municipality and department. It shows where and when fire happens, compares any period with normal, and gives an early warning before the burning season.

## ¿Qué hace?
- **Mapa:** dónde se concentran los focos de fuego, por municipio y departamento, en cualquier año o mes.
- **Calendario:** cada fila es un año y cada cuadro un mes; muestra la temporada de quemas de cada lugar.
- **Alerta:** compara lo que va del año con lo normal y dice cuánto falta para la temporada.
- **Datos:** recibe los archivos de NASA FIRMS, los procesa en el navegador y publica la actualización.

## El método (armonización)
1. **Contamos focos, no puntos:** cuadros de 11 × 11 km por día, para que MODIS y VIIRS midan lo mismo.
2. **Armonizamos:** factor VIIRS/MODIS por región (2°) y mes, calibrado en 2013–2021 (≈3,5×), y corrección de los años en que solo existía Terra.
3. **Validamos:** calibrando con 2013–2017 y prediciendo 2018–2021, el error nacional fue de **3 %** (r = 0,92).
4. **Seguimos sin cortes:** Suomi NPP dejó de enviar datos el 2 de noviembre de 2026. Su reemplazo, **NOAA-20**, ve un 2 % más (factor 1,021; r mensual = 0,998 en 2018–2026; error de validación 1,3 %). FLARE continúa con NOAA-20 ajustado a la escala de Suomi NPP.

## Estructura
| Carpeta / archivo | Qué es |
|---|---|
| `index.html` | Toda la página (mapa, calendario, alerta, datos, nosotros) |
| `datos/mapa.js` | Focos armonizados por celda, año y mes (generado con Python) |
| `datos/departamentos.js`, `datos/municipios.js` | Límites de Colombia (geoBoundaries) |
| `js/motor-flare.js` | El método en JavaScript (lo usa la página "Datos") |
| `procesamiento/` | Scripts de Python: procesar, exportar y graficar |
| `img/` | Imagen para compartir el link e ícono |

## Cómo verla en tu computador
Abre `index.html` con Live Server en VS Code (necesita internet para el mapa base y los gráficos).

## Fuentes
NASA FIRMS (MODIS C6.1, VIIRS S-NPP 375 m y VIIRS NOAA-20 375 m) · geoBoundaries · Esri · Leaflet · ECharts.
