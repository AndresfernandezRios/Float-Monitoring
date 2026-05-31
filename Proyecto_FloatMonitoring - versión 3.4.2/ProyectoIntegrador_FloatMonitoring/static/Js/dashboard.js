const API_URL = "http://localhost:8000/api";

let chartPh, chartTempAgua, chartTempAmb;
let rolUsuario = null;
let umbrales = { ph: null, temp_ambiente: null, temp_agua: null };

// ─── 1. VERIFICAR SESIÓN Y ROL ────────────────────────────────────────────────
async function verificarSesion() {
    try {
        const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
        if (!res.ok) { window.location.href = "/login"; return false; }
        const usuario = await res.json();
        rolUsuario = usuario.rol;

        document.getElementById("usuario-nombre").textContent = usuario.username;
        document.getElementById("usuario-rol").textContent =
            { admin: "Admin", docente: "Docente", estudiante: "Estudiante" }[usuario.rol] || usuario.rol;

        if (usuario.rol === "admin") {
            document.getElementById("btn-admin").classList.remove("d-none");
        }
        return true;
    } catch {
        window.location.href = "/login";
        return false;
    }
}

// ─── 2. LOGOUT ────────────────────────────────────────────────────────────────
async function cerrarSesion() {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/login";
}

// ─── 3. VERIFICAR CALIBRACIÓN ─────────────────────────────────────────────────
async function verificarCalibracion() {
    // Solo aplica para docentes y admins
    if (rolUsuario === "estudiante") return;

    try {
        const res = await fetch(`${API_URL}/calibracion`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();

        // Si NO necesita calibración → limpiar el flag para que la próxima vez
        // que sí haga falta, el popup aparezca correctamente
        if (!data.needs_calibration) {
            sessionStorage.removeItem("calibracion_popup_mostrado");
            return;
        }

        // ── Mostrar banner persistente ──
        const banner = document.getElementById("banner-calibracion");
        const bannerTexto = document.getElementById("banner-calibracion-texto");

        const textoAlerta = data.dias_transcurridos !== null
            ? `Han pasado <strong>${data.dias_transcurridos} días</strong> desde la última calibración (${data.ultima_calibracion}).`
            : "No hay ninguna calibración registrada en el sistema.";

        bannerTexto.innerHTML = textoAlerta;
        banner.style.display = "block";

        // ── Mostrar popup solo una vez por sesión ──
        // Usamos sessionStorage para que no aparezca en cada refresco
        if (!sessionStorage.getItem("calibracion_popup_mostrado")) {
            sessionStorage.setItem("calibracion_popup_mostrado", "true");

            const titulo = document.getElementById("modal-calibracion-titulo");
            const detalle = document.getElementById("modal-calibracion-detalle");

            titulo.textContent = data.dias_transcurridos !== null
                ? `${data.dias_transcurridos} días sin calibrar`
                : "Sin calibraciones registradas";

            detalle.textContent = data.dias_transcurridos !== null
                ? `La última calibración fue el ${data.ultima_calibracion}, registrada por ${data.registrado_por}. El sistema pierde precisión con el tiempo.`
                : "Registra la primera calibración para habilitar el seguimiento de precisión.";

            bootstrap.Modal.getOrCreateInstance(
                document.getElementById("modalCalibracion")
            ).show();
        }

    } catch (err) {
        console.error("Error al verificar calibración:", err);
    }
}

// ─── 4. ABRIR MODAL DESDE EL BANNER ──────────────────────────────────────────
function abrirModalCalibrar() {
    bootstrap.Modal.getOrCreateInstance(
        document.getElementById("modalCalibracion")
    ).show();
}

// ─── 5. REGISTRAR CALIBRACIÓN ─────────────────────────────────────────────────
async function registrarCalibracion() {
    const notas = document.getElementById("notas-calibracion").value.trim();

    try {
        const res = await fetch(`${API_URL}/calibracion`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ notas: notas || null })
        });

        if (res.ok) {
            // Ocultar modal y banner
            bootstrap.Modal.getInstance(
                document.getElementById("modalCalibracion")
            ).hide();
            document.getElementById("banner-calibracion").style.display = "none";

            // Limpiar flag de sesión para que no bloquee una próxima alerta real
            sessionStorage.removeItem("calibracion_popup_mostrado");

            // Mostrar confirmación
            mostrarToastCalibracion("Calibración registrada correctamente.", "success");
        } else {
            const error = await res.json();
            mostrarToastCalibracion(error.detail || "Error al registrar.", "danger");
        }
    } catch {
        mostrarToastCalibracion("No se pudo conectar con el servidor.", "danger");
    }
}

// Toast simple para feedback de calibración
function mostrarToastCalibracion(mensaje, tipo) {
    // Crear toast dinámico sin necesitar un elemento fijo en el HTML
    const div = document.createElement("div");
    div.className = `toast align-items-center text-white bg-${tipo} border-0 show position-fixed bottom-0 end-0 m-3`;
    div.style.zIndex = "9999";
    div.innerHTML = `<div class="d-flex">
        <div class="toast-body fw-semibold">${mensaje}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.parentElement.parentElement.remove()"></button>
    </div>`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
}

// ─── 6. CARGAR UMBRALES (solo una vez) ────────────────────────────────────────
async function cargarUmbrales() {
    try {
        const [rPh, rAmb, rAgua] = await Promise.all([
            fetch(`${API_URL}/umbrales/ph`, { credentials: "include" }),
            fetch(`${API_URL}/umbrales/temp_ambiente`, { credentials: "include" }),
            fetch(`${API_URL}/umbrales/temp_agua`, { credentials: "include" }),
        ]);
        umbrales.ph = await rPh.json();
        umbrales.temp_ambiente = await rAmb.json();
        umbrales.temp_agua = await rAgua.json();
    } catch (err) {
        console.error("No se pudieron cargar los umbrales:", err);
    }
}

// ─── 7. INICIALIZAR GRÁFICAS ──────────────────────────────────────────────────
function inicializarGraficas() {
    const commonOptions = {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { beginAtZero: false }
        }
    };
    chartPh = new Chart(document.getElementById("chartPh"), {
        type: "line",
        data: {
            labels: [], datasets: [{
                data: [], borderColor: "#0d6efd",
                backgroundColor: "rgba(13,110,253,0.1)", tension: 0.3, fill: true
            }]
        },
        options: commonOptions
    });
    chartTempAgua = new Chart(document.getElementById("chartTempAgua"), {
        type: "line",
        data: { labels: [], datasets: [{ data: [], borderColor: "#0dcaf0", tension: 0.3 }] },
        options: commonOptions
    });
    chartTempAmb = new Chart(document.getElementById("chartTempAmb"), {
        type: "line",
        data: { labels: [], datasets: [{ data: [], borderColor: "#dc3545", tension: 0.3 }] },
        options: commonOptions
    });
}

// ─── 8. VERIFICAR ALERTAS ─────────────────────────────────────────────────────
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
        const msgEl = card.querySelector(".alerta-umbral"); // div de mensaje de umbral

        // No alertar sensores sin datos reales (null del backend → "ND" en pantalla)
        if (c.valor === null || c.valor === undefined || elemento.innerText === "ND") {
            card.classList.remove("bg-danger", "text-white");
            elemento.className = `value-display ${c.colorOk}`;
            if (msgEl) msgEl.remove();
            card.querySelectorAll(".text-white-50").forEach(el => {
                el.classList.add("text-muted");
                el.classList.remove("text-white-50");
            });
            continue;
        }

        if (c.umbral && (c.valor < c.umbral.minimo || c.valor > c.umbral.maximo)) {
            // ── Alerta: fondo rojo, todo el texto en blanco ──
            card.classList.add("bg-danger", "text-white");
            elemento.className = "value-display text-white";
            card.querySelectorAll(".text-muted").forEach(el => {
                el.classList.add("text-white-50");
                el.classList.remove("text-muted");
            });

            // Mensaje indicando qué umbral se superó
            const esMayor = c.valor > c.umbral.maximo;
            const textoMsg = esMayor
                ? `<i class="bi bi-arrow-up-circle-fill me-1"></i>Supera el máximo (${c.umbral.maximo})`
                : `<i class="bi bi-arrow-down-circle-fill me-1"></i>Bajo el mínimo (${c.umbral.minimo})`;

            // Crear o actualizar el div de mensaje
            if (msgEl) {
                msgEl.innerHTML = textoMsg;
            } else {
                const nuevo = document.createElement("div");
                nuevo.className = "alerta-umbral small fw-semibold text-white mt-1";
                nuevo.innerHTML = textoMsg;
                elemento.insertAdjacentElement("afterend", nuevo);
            }

        } else {
            // ── Normal: restaurar colores originales ──
            card.classList.remove("bg-danger", "text-white");
            elemento.className = `value-display ${c.colorOk}`;
            card.querySelectorAll(".text-white-50").forEach(el => {
                el.classList.add("text-muted");
                el.classList.remove("text-white-50");
            });
            // Eliminar mensaje de umbral si existía
            if (msgEl) msgEl.remove();
        }
    }
}

// ─── 9. ACTUALIZAR DASHBOARD ──────────────────────────────────────────────────

// Formatea un valor para mostrarlo en la caja:
// null (sensor desconectado) → "ND", número → el valor
function formatearCaja(valor) {
    return valor === null || valor === undefined ? "ND" : valor;
}

async function actualizarDashboard() {
    try {
        // Endpoint dedicado: últimas 15 mediciones del día actual
        const res = await fetch(`${API_URL}/mediciones/hoy?limite=15`, { credentials: "include" });
        if (res.status === 401) { window.location.href = "/login"; return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const datos = await res.json();

        // Sin mediciones hoy → mostrar ND en todas las cajas
        if (datos.length === 0) {
            ["caja-ph", "caja-temp-amb", "caja-temp-agua"].forEach(id => {
                document.getElementById(id).innerText = "ND";
            });
            return;
        }

        const ultima = datos[0];

        // Mostrar "ND" cuando el sensor devolvió null (sensor desconectado)
        document.getElementById("caja-ph").innerText = formatearCaja(ultima.ph);
        document.getElementById("caja-temp-amb").innerText = formatearCaja(ultima.temp_ambiente);
        document.getElementById("caja-temp-agua").innerText = formatearCaja(ultima.temp_agua);
        document.getElementById("fecha-actualizacion").innerText = ultima.fecha_hora;

        verificarAlertas(ultima);

        // Gráficas: orden cronológico (más antiguo → más reciente)
        // Los null del backend se pasan directamente → Chart.js deja un hueco en la línea
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

        const badge = document.getElementById("connection-status");
        badge.innerText = "Online";
        badge.className = "badge bg-light text-primary me-3";

    } catch (err) {
        console.error("Error en dashboard:", err);
        const badge = document.getElementById("connection-status");
        badge.innerText = "Offline";
        badge.className = "badge bg-danger text-white me-3";
    }
}

// ─── 10. INICIO ───────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    const sesionOk = await verificarSesion();
    if (!sesionOk) return;

    inicializarGraficas();
    await cargarUmbrales();
    await actualizarDashboard();
    await verificarCalibracion();   // Verifica después de cargar el dashboard

    setInterval(actualizarDashboard, 3000);
});