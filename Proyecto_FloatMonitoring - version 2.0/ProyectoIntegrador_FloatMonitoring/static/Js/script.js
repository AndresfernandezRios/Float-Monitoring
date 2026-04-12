const API_URL = "http://localhost:8000/api";
let chartPH, chartTemp;

// --- 1. INICIALIZAR GRÁFICAS (Colores originales) ---
function inicializarGraficas() {
    const elPH = document.getElementById('grafica-ph');
    const elTemp = document.getElementById('grafica-temp');

    if (!elPH || !elTemp) return; // Si no están en la página (como en consultas.html), no hace nada

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: true, position: 'bottom' }
        },
        scales: {
            x: { ticks: { display: false } },
            y: { beginAtZero: false, grace: '10%' }
        }
    };

    chartPH = new Chart(elPH.getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'pH del Agua',
                data: [],
                borderColor: '#0d6efd', // Azul Primary
                backgroundColor: 'rgba(13, 110, 253, 0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: commonOptions
    });

    chartTemp = new Chart(elTemp.getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'T. Ambiente (°C)',
                    data: [],
                    borderColor: '#dc3545', // Rojo Danger
                    tension: 0.3,
                    fill: false
                },
                {
                    label: 'T. Agua (°C)',
                    data: [],
                    borderColor: '#0dcaf0', // Cian Info
                    tension: 0.3,
                    fill: false
                }
            ]
        },
        options: commonOptions
    });
}

// --- 2. FUNCIÓN DE ALERTA ---
function aplicarEstiloAlerta(elementoId, valorActual, umbral) {
    const elemento = document.getElementById(elementoId);
    if (!elemento || !umbral) return;

    const tarjeta = elemento.closest('.card');
    if (!tarjeta) return;

    const valor = parseFloat(valorActual);
    const min = parseFloat(umbral.minimo);
    const max = parseFloat(umbral.maximo);

    if (valor < min || valor > max) {
        // Alerta: Fondo rojo, texto blanco (como pediste)
        tarjeta.style.backgroundColor = "#dc3545";
        tarjeta.style.color = "white";
        tarjeta.querySelectorAll('.text-muted').forEach(el => el.classList.replace('text-muted', 'text-white-50'));
    } else {
        // Normal: Fondo blanco, texto original
        tarjeta.style.backgroundColor = "white";
        tarjeta.style.color = "";
        tarjeta.querySelectorAll('.text-white-50').forEach(el => el.classList.replace('text-white-50', 'text-muted'));
    }
}

// --- 3. CARGAR DATOS ---
async function cargarDatos() {
    try {
        const resMediciones = await fetch(`${API_URL}/mediciones?limite=10`);
        const datos = await resMediciones.json();

        // Intentar cargar umbrales (solo si existen los elementos en el DOM)
        const [rPh, rAmb, rAgua] = await Promise.all([
            fetch(`${API_URL}/umbrales/ph`),
            fetch(`${API_URL}/umbrales/temp_ambiente`),
            fetch(`${API_URL}/umbrales/temp_agua`)
        ]);

        const uPh = await rPh.json();
        const uAmb = await rAmb.json();
        const uAgua = await rAgua.json();

        if (datos.length > 0) {
            const ultimo = datos[0];

            // Actualizar textos si existen
            if (document.getElementById('ph-val')) document.getElementById('ph-val').innerText = ultimo.ph;
            if (document.getElementById('temp-amb-val')) document.getElementById('temp-amb-val').innerText = ultimo.temp_ambiente;
            if (document.getElementById('temp-agua-val')) document.getElementById('temp-agua-val').innerText = ultimo.temp_agua;

            // Alertas
            aplicarEstiloAlerta('ph-val', ultimo.ph, uPh);
            aplicarEstiloAlerta('temp-amb-val', ultimo.temp_ambiente, uAmb);
            aplicarEstiloAlerta('temp-agua-val', ultimo.temp_agua, uAgua);

            // Actualizar Tabla si existe
            const tabla = document.getElementById('tabla-cuerpo');
            if (tabla) {
                tabla.innerHTML = datos.map(reg => `
                    <tr>
                        <td><small class="text-muted">${reg.fecha_hora.split(' ')[1] || reg.fecha_hora}</small></td>
                        <td><span class="badge bg-primary-subtle text-primary">${reg.ph}</span></td>
                        <td class="text-danger">${reg.temp_ambiente}°C</td>
                        <td class="text-info">${reg.temp_agua}°C</td>
                    </tr>
                `).join('');
            }

            // Actualizar Gráficas si están inicializadas
            if (chartPH && chartTemp) {
                const historial = [...datos].reverse();
                const etiquetas = historial.map(d => d.fecha_hora.split(' ')[1] || "");

                chartPH.data.labels = etiquetas;
                chartPH.data.datasets[0].data = historial.map(d => d.ph);
                chartPH.update();

                chartTemp.data.labels = etiquetas;
                chartTemp.data.datasets[0].data = historial.map(d => d.temp_ambiente);
                chartTemp.data.datasets[1].data = historial.map(d => d.temp_agua);
                chartTemp.update();
            }
        }
    } catch (err) {
        console.error("Error en el flujo de datos:", err);
    }
}

// --- 4. GUARDAR UMBRALES ---
document.addEventListener('submit', async (e) => {
    if (e.target && e.target.id === 'form-umbrales') {
        e.preventDefault();
        const alertCont = document.getElementById('alert-container');
        const variable = document.getElementById('update-variable').value;
        const datosConfig = {
            minimo: parseFloat(document.getElementById('update-min').value),
            maximo: parseFloat(document.getElementById('update-max').value)
        };

        try {
            const res = await fetch(`${API_URL}/umbrales/${variable}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(datosConfig)
            });
            if (res.ok && alertCont) {
                alertCont.innerHTML = `<div class="alert alert-success py-2 small">Actualizado correctamente</div>`;
                setTimeout(() => alertCont.innerHTML = "", 3000);
            }
        } catch (err) {
            console.error("Error al guardar umbrales:", err);
        }
    }
});

// --- 5. ARRANQUE ---
document.addEventListener('DOMContentLoaded', () => {
    inicializarGraficas();
    cargarDatos();
    setInterval(cargarDatos, 3000);
});