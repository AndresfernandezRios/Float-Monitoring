const API_URL = "http://localhost:8000/api";
let chartHistorico;
let rolUsuario = null;

function mostrarToast(mensaje, tipo = "success") {
    const toast = document.getElementById("app-toast");
    const cuerpo = document.getElementById("toast-mensaje");
    toast.className = `toast align-items-center border-0 text-white bg-${tipo}`;
    cuerpo.textContent = mensaje;
    bootstrap.Toast.getOrCreateInstance(toast, { delay: 3000 }).show();
}

async function verificarSesion() {
    try {
        const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
        if (!res.ok) { window.location.href = "/login"; return false; }
        const usuario = await res.json();
        rolUsuario = usuario.rol;

        document.getElementById("usuario-nombre").textContent = usuario.username;
        document.getElementById("usuario-rol").textContent =
            { admin: "Admin", docente: "Docente", estudiante: "Estudiante" }[usuario.rol] || usuario.rol;

        // Botón Admin solo para admin
        if (usuario.rol === "admin") {
            document.getElementById("btn-admin").classList.remove("d-none");
        }

        // Panel de umbrales: visible solo para docente y admin
        if (usuario.rol === "estudiante") {
            const panel = document.getElementById("panel-umbrales");
            if (panel) panel.style.display = "none";
        }

        return true;
    } catch {
        window.location.href = "/login";
        return false;
    }
}

async function cerrarSesion() {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/login";
}

async function cargarUmbralesActuales() {
    const lista = document.getElementById("lista-umbrales");
    try {
        const variables = [
            { id: "ph", nombre: "pH" },
            { id: "temp_ambiente", nombre: "T. Amb" },
            { id: "temp_agua", nombre: "T. Agua" }
        ];
        const respuestas = await Promise.all(
            variables.map(v => fetch(`${API_URL}/umbrales/${v.id}`, { credentials: "include" }))
        );
        const datos = await Promise.all(respuestas.map(r => r.json()));
        let html = '<ul class="list-group list-group-flush">';
        variables.forEach((v, i) => {
            html += `<li class="list-group-item px-0 py-1 d-flex justify-content-between align-items-center">
                <span>${v.nombre}:</span>
                <span class="badge bg-secondary opacity-75">${datos[i].minimo} – ${datos[i].maximo}</span>
            </li>`;
        });
        lista.innerHTML = html + "</ul>";
    } catch {
        lista.innerHTML = '<span class="text-danger small"><i class="bi bi-wifi-off"></i> Error al conectar</span>';
    }
}

// Rangos válidos cargados desde la BD (se llenan al iniciar la página)
let RANGOS_VALIDOS = {};

async function cargarRangos() {
    try {
        const res = await fetch(`${API_URL}/rangos`, { credentials: "include" });
        if (!res.ok) return;
        const datos = await res.json();
        datos.forEach(r => {
            RANGOS_VALIDOS[r.variable] = { min: r.minimo, max: r.maximo, unidad: r.unidad };
        });
    } catch (err) {
        console.error("No se pudieron cargar los rangos de sensores:", err);
    }
}

function mostrarErrorUmbral(mensaje) {
    const div = document.getElementById("error-umbral");
    const texto = document.getElementById("error-umbral-texto");
    texto.textContent = mensaje;
    div.classList.remove("d-none");
}

function ocultarErrorUmbral() {
    document.getElementById("error-umbral").classList.add("d-none");
}

async function guardarUmbral() {
    ocultarErrorUmbral();

    if (rolUsuario !== "docente" && rolUsuario !== "admin") {
        mostrarErrorUmbral("No tienes permisos para modificar umbrales.");
        return;
    }

    const variable = document.getElementById("variable-umbral").value;
    const minRaw = document.getElementById("val-min").value;
    const maxRaw = document.getElementById("val-max").value;

    // Validar que los campos no estén vacíos
    if (minRaw === "" || maxRaw === "") {
        mostrarErrorUmbral("Debes completar ambos límites antes de guardar.");
        return;
    }

    const minNum = parseFloat(minRaw);
    const maxNum = parseFloat(maxRaw);

    // Validar que sean números reales
    if (isNaN(minNum) || isNaN(maxNum)) {
        mostrarErrorUmbral("Los valores ingresados no son números válidos.");
        return;
    }

    // Validar que mínimo sea menor que máximo
    if (minNum >= maxNum) {
        mostrarErrorUmbral(
            `El valor mínimo (${minNum}) debe ser estrictamente menor que el máximo (${maxNum}).`
        );
        return;
    }

    // Validar rango físico válido para cada variable
    const rango = RANGOS_VALIDOS[variable];
    if (minNum < rango.min || maxNum > rango.max) {
        mostrarErrorUmbral(
            `Para ${variable} los valores deben estar entre ${rango.min} y ${rango.max} ${rango.unidad}.`
        );
        return;
    }

    try {
        const res = await fetch(`${API_URL}/umbrales/${variable}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ minimo: minNum, maximo: maxNum })
        });
        if (res.ok) {
            mostrarToast(`Umbral de ${variable} actualizado correctamente.`, "success");
            cargarUmbralesActuales();
            document.getElementById("val-min").value = "";
            document.getElementById("val-max").value = "";
            ocultarErrorUmbral();
        } else {
            const error = await res.json();
            mostrarErrorUmbral(error.detail || "Error al actualizar el umbral.");
        }
    } catch {
        mostrarErrorUmbral("No se pudo conectar con el servidor.");
    }
}

async function buscarHistorial() {
    const tabla = document.getElementById("cuerpo-tabla");
    const contador = document.getElementById("contador-registros");
    const avisoFiltro = document.getElementById("aviso-filtro");
    const fechaInicio = document.getElementById("fecha-inicio").value;
    const fechaFin = document.getElementById("fecha-fin").value;

    tabla.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-4">
        <div class="spinner-border spinner-border-sm me-2"></div>Cargando...</td></tr>`;

    const hayFiltro = !!(fechaInicio && fechaFin);
    avisoFiltro.classList.toggle("d-none", !hayFiltro);

    const url = hayFiltro
        ? `${API_URL}/mediciones?limite=0&fecha_inicio=${encodeURIComponent(fechaInicio)}&fecha_fin=${encodeURIComponent(fechaFin)}`
        : `${API_URL}/mediciones?limite=10`;

    try {
        const res = await fetch(url, { credentials: "include" });
        if (res.status === 401) { window.location.href = "/login"; return; }
        if (!res.ok) throw new Error();
        const datos = await res.json();

        contador.textContent = `${datos.length} registro${datos.length !== 1 ? "s" : ""}`;

        if (datos.length === 0) {
            tabla.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-4">
                <i class="bi bi-inbox"></i> No hay registros para el rango seleccionado.</td></tr>`;
            actualizarGraficaHistorica([], [], [], []);
            return;
        }

        const datosOrdenados = datos.slice().reverse();
        const labels = [], dataPH = [], dataTW = [], dataTA = [];
        datosOrdenados.forEach(reg => {
            labels.push(reg.fecha_hora.split(" ")[1] || "");
            dataPH.push(reg.ph);
            dataTW.push(reg.temp_agua);
            dataTA.push(reg.temp_ambiente);
        });

        let filas = "";
        datos.forEach(reg => {
            filas += `<tr>
                <td><small class="text-muted">${reg.fecha_hora}</small></td>
                <td><b class="text-primary">${reg.ph}</b></td>
                <td>${reg.temp_ambiente}°C</td>
                <td>${reg.temp_agua}°C</td>
            </tr>`;
        });
        tabla.innerHTML = filas;
        actualizarGraficaHistorica(labels, dataPH, dataTW, dataTA);

    } catch (err) {
        tabla.innerHTML = `<tr><td colspan="4" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Error al cargar los datos.</td></tr>`;
    }
}

function limpiarFiltros() {
    document.getElementById("fecha-inicio").value = "";
    document.getElementById("fecha-fin").value = "";
    document.getElementById("aviso-filtro").classList.add("d-none");
    buscarHistorial();
}

function actualizarGraficaHistorica(labels, phs, tempsAgua, tempsAmb) {
    const ctx = document.getElementById("chartHistorico").getContext("2d");
    if (chartHistorico) chartHistorico.destroy();
    chartHistorico = new Chart(ctx, {
        type: "line",
        data: {
            labels, datasets: [
                {
                    label: "pH", data: phs, borderColor: "#0d6efd",
                    backgroundColor: "rgba(13,110,253,0.08)", tension: 0.3, fill: true, yAxisID: "yPH"
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

document.addEventListener("DOMContentLoaded", async () => {
    const ok = await verificarSesion();
    if (!ok) return;
    await cargarRangos();          // cargar rangos físicos desde BD antes de cualquier validación
    cargarUmbralesActuales();
    buscarHistorial();
});