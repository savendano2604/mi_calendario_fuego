"""
graficas.py — Gráficas para la presentación (FLARE / Calendario de Fuego)

Uso:
    python graficas.py <carpeta_modis> <carpeta_viirs> <carpeta_salida>

Crea dos imágenes PNG:
  1_antes_despues.png  -> focos por año, sin armonizar vs armonizado
  2_validacion.png     -> el "examen": lo que predijimos vs lo que VIIRS vio
"""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import procesar_datos as pd_flare   # reutilizamos las funciones del procesamiento

NARANJA, GRIS, FONDO, TEXTO, AZUL = "#ff6a1a", "#9a8b7e", "#1c0f08", "#f3ece5", "#6fc3ff"
plt.rcParams.update({
    "figure.facecolor": FONDO, "axes.facecolor": FONDO, "savefig.facecolor": FONDO,
    "text.color": TEXTO, "axes.labelcolor": TEXTO, "xtick.color": TEXTO, "ytick.color": TEXTO,
    "axes.edgecolor": "#4a2a18", "font.size": 13, "axes.titleweight": "bold", "axes.titlesize": 18,
})


def miles(x, _=None):
    return f"{x:,.0f}".replace(",", ".")


def main(carpeta_modis, carpeta_viirs, salida):
    md = pd_flare.cargar(carpeta_modis, "modis")
    vd = pd_flare.cargar(carpeta_viirs, "viirs")
    m, mt, v = pd_flare.celdas_dia(md), pd_flare.celdas_dia(md[md.satellite == "Terra"]), pd_flare.celdas_dia(vd)

    # ---------- Serie anual sin armonizar y armonizada ----------
    kreg, knac = pd_flare.factores_viirs_modis(m, v, pd_flare.AÑOS_CALIB)
    kterra = pd_flare.factor_terra(m, mt, range(2003, 2022))
    pre = m[m.fecha < pd_flare.INICIO_VIIRS].copy()
    pre["k"] = pd_flare.aplicar(pre, kreg, knac, kterra)
    pos = v[v.fecha >= pd_flare.INICIO_VIIRS]
    años = list(range(2001, 2026))                      # años completos
    crudo = (pre.groupby("año").size().add(pos.groupby("año").size(), fill_value=0)).reindex(años)
    arm = (pre.groupby("año").k.sum().add(pos.groupby("año").size(), fill_value=0)).reindex(años)

    fig, ax = plt.subplots(figsize=(13, 6.5))
    ax.axvspan(2000.5, 2011.5, color=AZUL, alpha=0.06)
    ax.text(2006, arm.max() * 1.07, "Solo MODIS", color=AZUL, ha="center", fontsize=12)
    ax.text(2019, arm.max() * 1.07, "MODIS + VIIRS", color=AZUL, ha="center", fontsize=12)
    ax.plot(años, crudo, "--o", color=GRIS, lw=2, ms=5, label="Sin armonizar (como vienen los datos)")
    ax.plot(años, arm, "-o", color=NARANJA, lw=3, ms=7, label="Armonizado (nuestro método)")
    ax.annotate("Salto FALSO:\nllega VIIRS (×3,7)", xy=(2012, crudo[2012]), xytext=(2007.2, crudo[2012] * 0.62),
                color=TEXTO, fontsize=12, arrowprops=dict(arrowstyle="->", color=TEXTO))
    ax.annotate("Llega Aqua\n(jul 2002)", xy=(2002.5, crudo[2003]), xytext=(2001.3, crudo[2003] + 14000),
                color=GRIS, fontsize=11, arrowprops=dict(arrowstyle="->", color=GRIS))
    ax.set_title("Focos de fuego por año en Colombia: antes y después de armonizar", loc="left")
    ax.set_ylabel("Focos de fuego al año")
    ax.yaxis.set_major_formatter(miles)
    ax.set_xticks(años[::2])
    ax.set_ylim(0, arm.max() * 1.15)
    ax.grid(axis="y", color="#3a2418")
    ax.legend(loc="lower right", frameon=False)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    fig.text(0.01, 0.01, "Datos: NASA FIRMS (MODIS C6.1, VIIRS S-NPP 375 m), Colombia 2001–2025.", color=GRIS, fontsize=10)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(f"{salida}/1_antes_despues.png", dpi=160)
    plt.close(fig)

    # ---------- Validación: calibrar 2013-2017, predecir 2018-2021 ----------
    kr, kn = pd_flare.factores_viirs_modis(m, v, range(2013, 2018))
    prueba = m[m.año.between(2018, 2021)].copy()
    prueba["k"] = pd_flare.aplicar(prueba, kr, kn, kterra)
    pa = [2018, 2019, 2020, 2021]
    real = v[v.año.between(2018, 2021)].groupby("año").size().reindex(pa)
    pred = prueba.groupby("año").k.sum().reindex(pa)
    cru = prueba.groupby("año").size().reindex(pa)

    fig, ax = plt.subplots(figsize=(13, 6.5))
    x = np.arange(len(pa)); w = 0.27
    ax.bar(x - w, cru, w, color=GRIS, label="Solo MODIS, sin armonizar")
    ax.bar(x, pred, w, color=NARANJA, label="Nuestra predicción (MODIS armonizado)")
    ax.bar(x + w, real, w, color=AZUL, label="Lo que VIIRS vio de verdad")
    for i in range(len(pa)):
        err = (pred.iloc[i] - real.iloc[i]) / real.iloc[i] * 100
        ax.text(x[i], pred.iloc[i] + 900, f"{err:+.0f}%".replace("+-", "−").replace("-", "−"),
                ha="center", color=NARANJA, fontweight="bold")
    ax.set_xticks(x, [str(a) for a in pa])
    ax.set_title("El examen: calibramos con 2013–2017 y predijimos 2018–2021", loc="left")
    ax.set_ylabel("Focos de fuego al año")
    ax.yaxis.set_major_formatter(miles)
    ax.set_ylim(0, real.max() * 1.25)
    ax.grid(axis="y", color="#3a2418")
    ax.legend(loc="upper right", frameon=False, ncol=3, fontsize=11)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    error = float(np.mean(np.abs(pred - real) / real) * 100)
    fig.text(0.01, 0.01, f"Error promedio de la predicción: {str(round(error, 1)).replace(".", ",")} %. Sin armonizar, MODIS se queda corto en ~{(1 - (cru / real).mean()) * 100:.0f} %.",
             color=GRIS, fontsize=11)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(f"{salida}/2_validacion.png", dpi=160)
    plt.close(fig)
    print("Listo:", salida)


if __name__ == "__main__":
    main(*sys.argv[1:4])
