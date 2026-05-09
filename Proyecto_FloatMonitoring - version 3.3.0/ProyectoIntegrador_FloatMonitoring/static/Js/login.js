const API_URL = "http://localhost:8000/api";

// Mostrar/ocultar contraseña
document.getElementById("toggle-password").addEventListener("click", () => {
    const input = document.getElementById("password");
    const icon  = document.getElementById("eye-icon");
    if (input.type === "password") {
        input.type = "text";
        icon.className = "bi bi-eye-slash";
    } else {
        input.type = "password";
        icon.className = "bi bi-eye";
    }
});

// Login al presionar Enter
document.getElementById("password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") iniciarSesion();
});
document.getElementById("username").addEventListener("keydown", (e) => {
    if (e.key === "Enter") iniciarSesion();
});

async function iniciarSesion() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const alerta   = document.getElementById("alerta-error");
    const mensaje  = document.getElementById("mensaje-error");
    const btnTexto  = document.getElementById("btn-texto");
    const spinner   = document.getElementById("btn-spinner");
    const btn       = document.getElementById("btn-login");

    // Ocultar error previo
    alerta.classList.add("d-none");

    if (!username || !password) {
        mensaje.textContent = "Por favor completa usuario y contraseña.";
        alerta.classList.remove("d-none");
        return;
    }

    // Estado de carga
    btn.disabled     = true;
    btnTexto.textContent = "Ingresando...";
    spinner.classList.remove("d-none");

    try {
        const res = await fetch(`${API_URL}/auth/login`, {
            method:      "POST",
            headers:     { "Content-Type": "application/json" },
            credentials: "include",   // necesario para que el navegador guarde la cookie
            body:        JSON.stringify({ username, password })
        });

        if (res.ok) {
            // Login exitoso → redirigir al dashboard
            window.location.href = "/";
        } else {
            const error = await res.json();
            mensaje.textContent = error.detail || "Error al iniciar sesión.";
            alerta.classList.remove("d-none");
        }
    } catch (err) {
        mensaje.textContent = "No se pudo conectar con el servidor.";
        alerta.classList.remove("d-none");
        console.error("Error en login:", err);
    } finally {
        btn.disabled         = false;
        btnTexto.textContent = "Ingresar";
        spinner.classList.add("d-none");
    }
}
