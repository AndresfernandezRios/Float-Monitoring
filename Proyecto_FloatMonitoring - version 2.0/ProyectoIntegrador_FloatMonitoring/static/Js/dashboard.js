const API_URL = "http://localhost:8000/api";

let chartPh, chartTempAgua, chartTempAmb;

// CORRECCIÓN: los umbrales se guardan aquí y solo se cargan UNA VEZ al inicio.
// Antes se hacían 3 fetches extra en CADA ciclo de refresco (cada 3 segundos).
let umbrales = {
    ph: null,
    temp_ambiente: null,
    temp_agua: null,
};


// ─── 1. CARGAR UMBRALES (solo al inicio) ─────────────────────────────────────
async function cargarUmbrales() {
    try {
        // Peticiones en paralelo, no en serie
        const [rPh, rAmb, rAgua] = await Promise.all([
            fetch(`${API_URL}/umbrales/ph`),
            fetch(`${API_URL}/umbrales/temp_ambiente`),
            fetch(`${API_URL}/umbrales/temp_agua`),
        ]);
        umbrales.ph = await rPh.json();
        umbrales.temp_ambiente = await rAmb.json();
        umbrales.temp_agua = await rAgua.json();
    } catch (err) {
        console.error("No se pudieron cargar los umbrales:", err);
    }
}


// ─── 2. INICIALIZAR GRÁFICAS ──────────────────────────────────────────────────
function inicializarGraficas() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { beginAtZero: false },
        },
    };

    chartPh = new Chart(document.getElementById("chartPh"), {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: "#0d6efd",
                backgroundColor: "rgba(13, 110, 253, 0.1)",
                tension: 0.3,
                fill: true,
            }],
        },
        options: commonOptions,
    });

    chartTempAgua = new Chart(document.getElementById("chartTempAgua"), {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: "#0dcaf0",
                tension: 0.3,
            }],
        },
        options: commonOptions,
    });

    chartTempAmb = new Chart(document.getElementById("chartTempAmb"), {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                data: [],
                borderColor: "#dc3545",
                tension: 0.3,
            }],
        },
        options: commonOptions,
    });
}


// ─── 3. VERIFICAR ALERTAS (sin fetch, usa la variable global) ─────────────────
function verificarAlertas(medicion) {
    const checks = [
        { id: "caja-ph", valor: medicion.ph, umbral: umbrales.ph, colorOk: "text-primary" },
        { id: "caja-temp-amb", valor: medicion.temp_ambiente, umbral: umbrales.temp_ambiente, colorOk: "text-danger" },
        { id: "caja-temp-agua", valor: medicion.temp_agua, umbral: umbrales.temp_agua, colorOk: "text-info" },
    ];

    for (const c of checks) {
        const elemento = document.getElementById(c.id);
        if (!elemento) continue;

        const card = elemento.closest(".card");

        if (c.umbral && (c.valor < c.umbral.minimo || c.valor > c.umbral.maximo)) {
            // Fuera de rango → alerta roja
            card.classList.add("bg-danger", "text-white");
            elemento.className = "value-display text-white";
        } else {
            // Dentro del rango → restaurar colores originales
            card.classList.remove("bg-danger", "text-white");
            elemento.className = `value-display ${c.colorOk}`;
        }
    }
}


// ─── 4. ACTUALIZAR DASHBOARD ──────────────────────────────────────────────────
async function actualizarDashboard() {
    try {
        const res = await fetch(`${API_URL}/mediciones?limite=15`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const datos = await res.json();

        if (datos.length === 0) return;

        const ultima = datos[0];

        // Actualizar valores en las cajas — los IDs coinciden con index.html
        document.getElementById("caja-ph").innerText = ultima.ph;
        document.getElementById("caja-temp-amb").innerText = ultima.temp_ambiente;
        document.getElementById("caja-temp-agua").innerText = ultima.temp_agua;
        document.getElementById("fecha-actualizacion").innerText = ultima.fecha_hora;

        // Verificar alertas con umbrales ya cargados (sin fetch adicional)
        verificarAlertas(ultima);

        // Actualizar gráficas (historial más antiguo → más reciente, de izquierda a derecha)
        const historial = [...datos].reverse();
        const labels = historial.map(d => d.fecha_hora.split(" ")[1]);

        chartPh.data.labels = labels;
        chartPh.data.datasets[0].data = historial.map(d => d.ph);
        chartPh.update();

        chartTempAgua.data.labels = labels;
        chartTempAgua.data.datasets[0].data = historial.map(d => d.temp_agua);
        chartTempAgua.update();

        chartTempAmb.data.labels = labels;
        chartTempAmb.data.datasets[0].data = historial.map(d => d.temp_ambiente);
        chartTempAmb.update();

        // Indicador de conexión → Online
        const badge = document.getElementById("connection-status");
        badge.innerText = "Online";
        badge.className = "badge bg-light text-primary me-3";

    } catch (err) {
        console.error("Error en dashboard:", err);

        // Indicador de conexión → Offline
        const badge = document.getElementById("connection-status");
        badge.innerText = "Offline";
        badge.className = "badge bg-danger text-white me-3";
    }
}


// ─── 5. INICIO ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    inicializarGraficas();
    await cargarUmbrales();      // Primero cargar umbrales (una sola vez)
    await actualizarDashboard(); // Luego primera carga de datos
    setInterval(actualizarDashboard, 3000); // Refresco cada 3 segundos
});
