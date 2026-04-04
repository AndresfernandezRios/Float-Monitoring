const API_URL = "http://localhost:8000/api";
let chartPH, chartTemp;

// --- 1. INICIALIZAR GRÁFICAS ---
function inicializarGraficas() {
    const ctxPH = document.getElementById('grafica-ph').getContext('2d');
    const ctxTemp = document.getElementById('grafica-temp').getContext('2d');

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'bottom',
                labels: { boxWidth: 12, padding: 15 }
            }
        },
        scales: {
            x: { ticks: { display: false } },
            y: { beginAtZero: false, grace: '10%' }
        }
    };

    chartPH = new Chart(ctxPH, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'pH del Agua',
                data: [],
                borderColor: '#0d6efd',
                backgroundColor: 'rgba(13, 110, 253, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 2
            }]
        },
        options: commonOptions
    });

    chartTemp = new Chart(ctxTemp, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'T. Ambiente (°C)',
                    data: [],
                    borderColor: '#dc3545', // Rojo
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 2,
                    fill: false
                },
                {
                    label: 'T. Agua (°C)',
                    data: [],
                    borderColor: '#0dcaf0', // Azul/Cian
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 2,
                    fill: false
                }
            ]
        },
        options: commonOptions
    });
}

// --- FUNCIÓN DE ALERTA MEJORADA ---
function aplicarEstiloAlerta(elementoId, valorActual, umbral) {
    const elemento = document.getElementById(elementoId);
    if (!elemento || !umbral) return;

    const tarjeta = elemento.closest('.card');
    if (!tarjeta) return;

    // Convertimos todo a números por seguridad
    const valor = parseFloat(valorActual);
    const min = parseFloat(umbral.minimo);
    const max = parseFloat(umbral.maximo);


    console.log(`Chequeando ${elementoId}: Valor ${valor} | Rango [${min} - ${max}]`);

    if (valor < min || valor > max) {
        // Alerta: Fondo rojo, texto blanco
        tarjeta.style.backgroundColor = "#dc3545"; // Rojo Bootstrap
        tarjeta.style.color = "white";
        tarjeta.querySelectorAll('.text-muted').forEach(el => el.style.color = "rgba(255,255,255,0.8)");
    } else {
        // Normal: Fondo blanco, texto oscuro
        tarjeta.style.backgroundColor = "white";
        tarjeta.style.color = "black";
        tarjeta.querySelectorAll('.text-muted').forEach(el => el.style.color = "#6c757d");
    }
}

// --- CARGAR DATOS ---
async function cargarDatos() {
    try {
        const resMediciones = await fetch(`${API_URL}/mediciones?limite=10`);
        const datos = await resMediciones.json();

        // Cargamos los 3 umbrales
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

            // 1. Actualizar textos
            document.getElementById('ph-val').innerText = ultimo.ph;
            document.getElementById('temp-amb-val').innerText = ultimo.temp_ambiente;
            document.getElementById('temp-agua-val').innerText = ultimo.temp_agua;

            // 2. Ejecutar alertas
            aplicarEstiloAlerta('ph-val', ultimo.ph, uPh);
            aplicarEstiloAlerta('temp-amb-val', ultimo.temp_ambiente, uAmb);
            aplicarEstiloAlerta('temp-agua-val', ultimo.temp_agua, uAgua);

            // 3. Actualizar Tabla
            const tabla = document.getElementById('tabla-cuerpo');
            tabla.innerHTML = "";
            datos.forEach(reg => {
                const hora = reg.fecha_hora.split(' ')[1] || reg.fecha_hora;
                tabla.innerHTML += `
                    <tr>
                        <td><small class="text-muted">${hora}</small></td>
                        <td><span class="badge bg-primary-subtle text-primary">${reg.ph}</span></td>
                        <td>${reg.temp_ambiente}°C</td>
                        <td>${reg.temp_agua}°C</td>
                    </tr>`;
            });

            // 4. Actualizar Gráficas
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
    } catch (err) {
        console.error("Error en el flujo de datos:", err);
    }
}

// --- 4. GUARDAR NUEVOS UMBRALES ---
document.getElementById('form-umbrales')?.addEventListener('submit', async (e) => {
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
        const resultado = await res.json();

        if (res.ok) {
            alertCont.innerHTML = `<div class="alert alert-success py-2 small"> ${variable.toUpperCase()} actualizado</div>`;
        } else {
            alertCont.innerHTML = `<div class="alert alert-danger py-2 small"> ${resultado.detail}</div>`;
        }
        setTimeout(() => alertCont.innerHTML = "", 3000);
    } catch (err) {
        alertCont.innerHTML = `<div class="alert alert-warning py-2 small"> Error de conexión</div>`;
    }
});



// --- 5. ARRANQUE ---
document.addEventListener('DOMContentLoaded', () => {
    inicializarGraficas();
    cargarDatos();
    setInterval(cargarDatos, 3000);
});