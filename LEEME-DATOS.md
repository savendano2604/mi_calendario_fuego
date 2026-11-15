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
- **NOAA-20:** Suomi NPP dejó de enviar datos el 2 de noviembre de 2026. Los días posteriores al último día de Suomi NPP se toman de VIIRS NOAA-20 (satélite `N20`, archivos `J1V-C2`) divididos por `K_N20 = 1,021`, el factor medido con el mismo método en 2018-04-01 a 2026-10-24 (r mensual = 0,998; calibrando 2018–2022 y prediciendo 2023–2025, error nacional 1,3 %). Implementado igual en `js/motor-flare.js` y en `procesamiento/exportar_mapa.py` (4º argumento: carpeta de NOAA-20); verificado: 0 diferencias entre los dos.

## Si se cambia el método en Python
Hay que hacer el mismo cambio en `js/motor-flare.js` y copiarlo dentro de `index.html`
(bloque `<script type="text/plain" id="motorFlare">`), y volver a comparar los resultados.

## Actualización automática (GitHub Actions)
- `.github/workflows/actualizar-datos.yml` corre **todos los días a las 7:23 a. m. (Colombia)** y también a mano
  (pestaña **Actions → Actualizar datos de FLARE → Run workflow**).
- Ejecuta `procesamiento/actualizar_automatico.js`, que pide a la **API de NASA FIRMS** los focos de
  **VIIRS NOAA-20** en Colombia desde el día siguiente a la última fecha hasta **ayer** (UTC), y los procesa con
  **`js/motor-flare.js`**, el mismo motor y el mismo modo ("Agregar días nuevos") que la página Datos.
  Nada del método cambia.
- Antes de guardar revisa que la fecha avance, que el total no baje y que ningún mes anterior cambie.
  Si algo no cuadra, **no guarda nada** y la tarea queda en rojo (GitHub avisa por correo).
- Después de subir `datos/mapa.js` le pide a GitHub Pages que publique (lo que sube una tarea automática
  no lo dispara solo).
- La clave de la NASA va en el secreto **`FIRMS_MAP_KEY`** (Settings → Secrets and variables → Actions).
  Nunca se escribe en el código y en los registros sale como `***`.
- La subida manual desde la página Datos sigue funcionando igual, como respaldo.
