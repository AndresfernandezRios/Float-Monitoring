const API_URL = "http://localhost:8000/api";

// ─── UTILIDAD: Toast ──────────────────────────────────────────────────────────
function mostrarToast(mensaje, tipo = "success") {
    const toast = document.getElementById("app-toast");
    const cuerpo = document.getElementById("toast-mensaje");
    toast.className = `toast align-items-center border-0 text-white bg-${tipo}`;
    cuerpo.textContent = mensaje;
    bootstrap.Toast.getOrCreateInstance(toast, { delay: 3500 }).show();
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
async function cerrarSesion() {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/login";
}

// ─── 1. VERIFICAR SESIÓN ──────────────────────────────────────────────────────
async function verificarSesion() {
    try {
        const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
        if (!res.ok) { window.location.href = "/login"; return false; }
        const usuario = await res.json();
        if (usuario.rol !== "admin") { window.location.href = "/"; return false; }

        document.getElementById("usuario-nombre").textContent = usuario.username;
        document.getElementById("usuario-rol").textContent = "Admin";
        return true;
    } catch {
        window.location.href = "/login";
        return false;
    }
}

// ─── 2. CARGAR TABLA DE USUARIOS ─────────────────────────────────────────────
async function cargarUsuarios() {
    const tbody = document.getElementById("cuerpo-tabla-usuarios");
    try {
        const res = await fetch(`${API_URL}/admin/usuarios`, { credentials: "include" });
        if (!res.ok) throw new Error();
        const usuarios = await res.json();

        const coloresRol = {
            admin:       "rol-badge-admin",
            docente:     "rol-badge-docente",
            estudiante:  "rol-badge-estudiante"
        };
        const nombresRol = {
            admin: "Admin", docente: "Docente", estudiante: "Estudiante"
        };

        let filas = "";
        usuarios.forEach(u => {
            const badgeRol   = `<span class="badge ${coloresRol[u.rol]}">${nombresRol[u.rol]}</span>`;
            const badgeEstado = u.activo
                ? `<span class="badge bg-success">Activo</span>`
                : `<span class="badge bg-secondary">Inactivo</span>`;
            const btnEstado = u.activo
                ? `<button class="btn btn-sm btn-outline-warning" onclick="toggleEstado(${u.id})" title="Desactivar">
                        <i class="bi bi-slash-circle"></i>
                   </button>`
                : `<button class="btn btn-sm btn-outline-success" onclick="toggleEstado(${u.id})" title="Activar">
                        <i class="bi bi-check-circle"></i>
                   </button>`;

            filas += `
                <tr id="fila-${u.id}">
                    <td class="text-muted small">${u.id}</td>
                    <td class="fw-semibold">${u.username}</td>
                    <td>${badgeRol}</td>
                    <td>${badgeEstado}</td>
                    <td class="text-center">
                        <div class="d-flex justify-content-center gap-2">
                            <button class="btn btn-sm btn-outline-primary"
                                onclick="abrirModalPassword(${u.id}, '${u.username}')"
                                title="Cambiar contraseña">
                                <i class="bi bi-key"></i>
                            </button>
                            ${btnEstado}
                        </div>
                    </td>
                </tr>`;
        });

        tbody.innerHTML = filas;
    } catch {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">
            <i class="bi bi-exclamation-triangle"></i> Error al cargar usuarios.</td></tr>`;
    }
}

// ─── 3. MODAL: CAMBIAR CONTRASEÑA ────────────────────────────────────────────
function abrirModalPassword(userId, username) {
    document.getElementById("modal-user-id").value  = userId;
    document.getElementById("modal-username").textContent = username;
    document.getElementById("nueva-password").value    = "";
    document.getElementById("confirmar-password").value = "";
    document.getElementById("error-password").classList.add("d-none");
    bootstrap.Modal.getOrCreateInstance(document.getElementById("modalPassword")).show();
}

async function guardarPassword() {
    const userId    = document.getElementById("modal-user-id").value;
    const nueva     = document.getElementById("nueva-password").value;
    const confirmar = document.getElementById("confirmar-password").value;
    const errorDiv  = document.getElementById("error-password");

    errorDiv.classList.add("d-none");

    if (!nueva || !confirmar) {
        errorDiv.textContent = "Completa ambos campos.";
        errorDiv.classList.remove("d-none");
        return;
    }
    if (nueva.length < 6) {
        errorDiv.textContent = "La contraseña debe tener al menos 6 caracteres.";
        errorDiv.classList.remove("d-none");
        return;
    }
    if (nueva !== confirmar) {
        errorDiv.textContent = "Las contraseñas no coinciden.";
        errorDiv.classList.remove("d-none");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/usuarios/${userId}/password`, {
            method:      "PUT",
            headers:     { "Content-Type": "application/json" },
            credentials: "include",
            body:        JSON.stringify({ nueva_password: nueva })
        });

        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById("modalPassword")).hide();
            mostrarToast("Contraseña actualizada correctamente.", "success");
        } else {
            const error = await res.json();
            errorDiv.textContent = error.detail || "Error al actualizar.";
            errorDiv.classList.remove("d-none");
        }
    } catch {
        errorDiv.textContent = "No se pudo conectar con el servidor.";
        errorDiv.classList.remove("d-none");
    }
}

// ─── 4. ACTIVAR / DESACTIVAR USUARIO ─────────────────────────────────────────
async function toggleEstado(userId) {
    try {
        const res = await fetch(`${API_URL}/admin/usuarios/${userId}/activo`, {
            method:      "PUT",
            credentials: "include"
        });
        if (res.ok) {
            const data = await res.json();
            const accion = data.activo ? "activado" : "desactivado";
            mostrarToast(`Usuario ${accion} correctamente.`, data.activo ? "success" : "warning");
            cargarUsuarios();   // refresca la tabla
        } else {
            const error = await res.json();
            mostrarToast(error.detail || "Error al cambiar estado.", "danger");
        }
    } catch {
        mostrarToast("No se pudo conectar con el servidor.", "danger");
    }
}

// ─── 5. CREAR USUARIO ─────────────────────────────────────────────────────────
async function crearUsuario() {
    const username = document.getElementById("nuevo-username").value.trim();
    const password = document.getElementById("nuevo-password").value;
    const rol      = document.getElementById("nuevo-rol").value;
    const errorDiv = document.getElementById("error-crear");

    errorDiv.classList.add("d-none");

    if (!username || !password) {
        errorDiv.textContent = "Completa todos los campos.";
        errorDiv.classList.remove("d-none");
        return;
    }
    if (username.length < 3) {
        errorDiv.textContent = "El usuario debe tener al menos 3 caracteres.";
        errorDiv.classList.remove("d-none");
        return;
    }
    if (password.length < 6) {
        errorDiv.textContent = "La contraseña debe tener al menos 6 caracteres.";
        errorDiv.classList.remove("d-none");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/admin/usuarios`, {
            method:      "POST",
            headers:     { "Content-Type": "application/json" },
            credentials: "include",
            body:        JSON.stringify({ username, password, rol })
        });

        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById("modalCrear")).hide();
            document.getElementById("nuevo-username").value = "";
            document.getElementById("nuevo-password").value = "";
            mostrarToast(`Usuario '${username}' creado correctamente.`, "success");
            cargarUsuarios();
        } else {
            const error = await res.json();
            errorDiv.textContent = error.detail || "Error al crear usuario.";
            errorDiv.classList.remove("d-none");
        }
    } catch {
        errorDiv.textContent = "No se pudo conectar con el servidor.";
        errorDiv.classList.remove("d-none");
    }
}

// ─── INICIO ───────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    const ok = await verificarSesion();
    if (ok) cargarUsuarios();
});
