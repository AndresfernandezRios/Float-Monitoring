const API_URL = "http://localhost:8000/api";
let chartHistorico;

// ─── UTILIDAD: Toast ─────────────────────────────────────────────────────────
function mostrarToast(mensaje, tipo = "success") {
    const toast = document.getElementById("app-toast");
    const cuerpo = document.getElementById("toast-mensaje");
    toast.className = `toast align-items-center border-0 text-white bg-${tipo}`;
    cuerpo.textContent = mensaje;
    bootstrap.Toast.getOrCreateInstance(toast, { delay: 3000 }).show();
}

// ─── 1. CARGAR UMBRALES ACTUALES ─────────────────────────────────────────────
async function cargarUmbralesActuales() {
    const lista = document.getElementById("lista-umbrales");
    try {
        const variables = [
            { id: "ph", nombre: "pH" },
            { id: "temp_ambiente", nombre: "T. Amb" },
            { id: "temp_agua", nombre: "T. Agua" }
        ];

        const respuestas = await Promise.all(
            variables.map(v => fetch(`${API_URL}/umbrales/${v.id}`))
        );
        const datos = await Promise.all(respuestas.map(r => r.json()));

        let html = '<ul class="list-group list-group-flush">';
        variables.forEach((v, i) => {
            html += `
                <li class="list-group-item px-0 py-1 d-flex justify-content-between align-items-center">
                    <span>${v.nombre}:</span>
                    <span class="badge bg-secondary opacity-75">${datos[i].minimo} – ${datos[i].maximo}</span>
                </li>`;
        });
        lista.innerHTML = html + "</ul>";
    } catch (err) {
        lista.innerHTML = '<span class="text-danger small"><i class="bi bi-wifi-off"></i> Error al conectar</span>';
    }
}

// ─── 2. GUARDAR UMBRALES ─────────────────────────────────────────────────────
async function guardarUmbral() {
    const variable = document.getElementById("variable-umbral").value;
    const min = document.getElementById("val-min").value;
    const max = document.getElementById("val-max").value;

    if (!min || !max) { mostrarToast("Completa ambos límites.", "warning"); return; }

    const minNum = parseFloat(min);
    const maxNum = parseFloat(max);

    if (minNum >= maxNum) { mostrarToast("El mínimo debe ser menor que el máximo.", "warning"); return; }

    try {
        const res = await fetch(`${API_URL}/umbrales/${variable}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ minimo: minNum, maximo: maxNum })
        });

        if (res.ok) {
            mostrarToast(`Umbral de ${variable} actualizado.`, "success");
            cargarUmbralesActuales();
            document.getElementById("val-min").value = "";
            document.getElementById("val-max").value = "";
        } else {
            const error = await res.json();
            mostrarToast(error.detail || "Error al actualizar.", "danger");
        }
    } catch (err) {
        mostrarToast("No se pudo conectar con el servidor.", "danger");
    }
}

// ─── 3. BUSCAR HISTORIAL ──────────────────────────────────────────────────────
async function buscarHistorial() {
    const tabla = document.getElementById("cuerpo-tabla");
    const contador = document.getElementById("contador-registros");
    const avisoFiltro = document.getElementById("aviso-filtro");
    const fechaInicio = document.getElementById("fecha-inicio").value;
    const fechaFin = document.getElementById("fecha-fin").value;

    tabla.innerHTML = `
        <tr>
            <td colspan="4" class="text-center text-muted py-4">
                <div class="spinner-border spinner-border-sm me-2"></div>Cargando...
            </td>
        </tr>`;

    const hayFiltro = !!(fechaInicio && fechaFin);
    avisoFiltro.classList.toggle("d-none", !hayFiltro);

    // CORRECCIÓN: sin fechas → últimos 10. Con fechas → limite=0 (todos en ese rango)
    let url = hayFiltro
        ? `${API_URL}/mediciones?limite=0&fecha_inicio=${encodeURIComponent(fechaInicio)}&fecha_fin=${encodeURIComponent(fechaFin)}`
        : `${API_URL}/mediciones?limite=10`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const datos = await res.json();

        contador.textContent = `${datos.length} registro${datos.length !== 1 ? "s" : ""}`;

        if (datos.length === 0) {
            tabla.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-muted py-4">
                        <i class="bi bi-inbox"></i> No hay registros para el rango seleccionado.
                    </td>
                </tr>`;
            actualizarGraficaHistorica([], [], [], []);
            return;
        }

        // Copia invertida para la gráfica (cronológico: antiguo → reciente)
        const datosOrdenados = datos.slice().reverse();
        const labels = [], dataPH = [], dataTW = [], dataTA = [];

        datosOrdenados.forEach(reg => {
            labels.push(reg.fecha_hora.split(" ")[1] || "");
            dataPH.push(reg.ph);
            dataTW.push(reg.temp_agua);
            dataTA.push(reg.temp_ambiente);
        });

        // Tabla: más reciente primero (orden original de la API)
        let filas = "";
        datos.forEach(reg => {
            filas += `
                <tr>
                    <td><small class="text-muted">${reg.fecha_hora}</small></td>
                    <td><b class="text-primary">${reg.ph}</b></td>
                    <td>${reg.temp_ambiente}°C</td>
                    <td>${reg.temp_agua}°C</td>
                </tr>`;
        });

        tabla.innerHTML = filas;
        actualizarGraficaHistorica(labels, dataPH, dataTW, dataTA);

    } catch (err) {
        tabla.innerHTML = `
            <tr>
                <td colspan="4" class="text-center text-danger py-4">
                    <i class="bi bi-exclamation-triangle"></i> Error al cargar los datos.
                </td>
            </tr>`;
        console.error("Error en historial:", err);
    }
}

// ─── 4. LIMPIAR FILTROS ───────────────────────────────────────────────────────
function limpiarFiltros() {
    document.getElementById("fecha-inicio").value = "";
    document.getElementById("fecha-fin").value = "";
    document.getElementById("aviso-filtro").classList.add("d-none");
    buscarHistorial();
}

// ─── 5. GRÁFICA HISTÓRICA ─────────────────────────────────────────────────────
function actualizarGraficaHistorica(labels, phs, tempsAgua, tempsAmb) {
    const ctx = document.getElementById("chartHistorico").getContext("2d");
    if (chartHistorico) chartHistorico.destroy();

    chartHistorico = new Chart(ctx, {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "pH", data: phs,
                    borderColor: "#0d6efd", backgroundColor: "rgba(13,110,253,0.08)",
                    tension: 0.3, fill: true, yAxisID: "yPH"
                },
                {
                    label: "T. Agua (°C)", data: tempsAgua,
                    borderColor: "#0dcaf0", tension: 0.3, fill: false, yAxisID: "yTemp"
                },
                {
                    label: "T. Ambiente (°C)", data: tempsAmb,
                    borderColor: "#dc3545", tension: 0.3, fill: false, yAxisID: "yTemp"
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: { legend: { display: true, position: "bottom" } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 } },
                yPH: { type: "linear", position: "left", title: { display: true, text: "pH" }, min: 0, max: 14 },
                yTemp: { type: "linear", position: "right", title: { display: true, text: "°C" }, grid: { drawOnChartArea: false } }
            }
        }
    });
}

// ─── 6. INICIO ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    cargarUmbralesActuales();
    buscarHistorial();
});
