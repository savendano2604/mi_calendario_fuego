# FLARE · Actualización de datos desde la página

## Arquitectura
- **Procesamiento en el navegador:** la página "Datos" recibe los ZIP/CSV de NASA FIRMS y los procesa
  en un *Web Worker* (hilo aparte) con `js/motor-flare.js`, traducción exacta de
  `procesamiento/procesar_datos.py` + `exportar_mapa.py`. Verificado contra Python con los datos reales:
  mismas 6.879 celdas, mismos 1.174.825 focos, mismos factores (3,51× y 3,13×) y misma validación (3,2 %).
- **Dos modos:** *Agregar días nuevos* (VIIRS posteriores a la última fecha, segundos) y
  *Procesar todo desde cero* (MODIS 2001+ y VIIRS 2012+, ~5 s en un computador normal).
- **Guardado:** el resultado se guarda en el navegador (IndexedDB) y la página arranca con él.
  "Volver a los datos originales" lo borra.
- **Publicar para todos:** la página sube `datos/mapa.js` al repositorio con la API de GitHub
  (token *fine-grained* con permiso Contents: Read and write, solo para este repositorio).
  GitHub Pages se redespliega sola en 1–2 minutos. El token nunca se guarda.
- Los archivos de la NASA **no salen del computador**: no hay servidor.

## Si se cambia el método en Python
Hay que hacer el mismo cambio en `js/motor-flare.js` y copiarlo dentro de `index.html`
(bloque `<script type="text/plain" id="motorFlare">`), y volver a comparar los resultados.
