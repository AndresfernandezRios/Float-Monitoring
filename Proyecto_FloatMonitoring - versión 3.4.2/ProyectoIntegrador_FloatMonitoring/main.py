import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
import psycopg2
import pytz
from fastapi import FastAPI, HTTPException, Query, Response, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from dotenv import load_dotenv
load_dotenv()

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── Zona horaria ─────────────────────────────────────────────────────────────
colombia_tz = pytz.timezone("America/Bogota")

# ─── Config BD ────────────────────────────────────────────────────────────────
DB_CONFIG = {
    "dbname":   os.getenv("DB_NAME",     "postgres"),
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     os.getenv("DB_PORT",     "5432"),
}

# ─── Sesiones en memoria ──────────────────────────────────────────────────────
sesiones: dict = {}
SESSION_DURATION_HOURS = 8
DIAS_LIMITE_CALIBRACION = 8   # Alerta si han pasado más de este número de días


def obtener_conexion():
    return psycopg2.connect(**DB_CONFIG)


# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="API Float Monitoring", version="3.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ─── Utilidades de sesión ─────────────────────────────────────────────────────
def verificar_sesion(session_token: Optional[str]) -> Optional[dict]:
    if not session_token or session_token not in sesiones:
        return None
    datos = sesiones[session_token]
    if datetime.now() > datos["expira"]:
        del sesiones[session_token]
        return None
    return datos


def requerir_sesion(session_token: Optional[str] = Cookie(default=None)) -> dict:
    usuario = verificar_sesion(session_token)
    if not usuario:
        raise HTTPException(
            status_code=401, detail="Sesión inválida o expirada.")
    return usuario


def requerir_docente(session_token: Optional[str] = Cookie(default=None)) -> dict:
    usuario = requerir_sesion(session_token)
    if usuario["rol"] not in ("docente", "admin"):
        raise HTTPException(
            status_code=403, detail="Acción reservada para docentes.")
    return usuario


def requerir_admin(session_token: Optional[str] = Cookie(default=None)) -> dict:
    usuario = requerir_sesion(session_token)
    if usuario["rol"] != "admin":
        raise HTTPException(
            status_code=403, detail="Acción reservada para administradores.")
    return usuario


# ─── Rutas HTML ───────────────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
async def get_dashboard(session_token: Optional[str] = Cookie(default=None)):
    if not verificar_sesion(session_token):
        return RedirectResponse(url="/login")
    return FileResponse("index.html")


@app.get("/consultas", include_in_schema=False)
async def get_consultas(session_token: Optional[str] = Cookie(default=None)):
    if not verificar_sesion(session_token):
        return RedirectResponse(url="/login")
    return FileResponse("consultas.html")


@app.get("/admin", include_in_schema=False)
async def get_admin(session_token: Optional[str] = Cookie(default=None)):
    usuario = verificar_sesion(session_token)
    if not usuario:
        return RedirectResponse(url="/login")
    if usuario["rol"] != "admin":
        return RedirectResponse(url="/")
    return FileResponse("admin.html")


@app.get("/login", include_in_schema=False)
async def get_login():
    return FileResponse("login.html")


# ─── Modelos ──────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class MedicionESP32(BaseModel):
    ph:            Optional[float] = Field(default=None, ge=0.0,   le=14.0)
    temp_ambiente: Optional[float] = Field(default=None, ge=-10.0, le=60.0)
    temp_agua:     Optional[float] = Field(default=None, ge=0.0,   le=100.0)
    fecha_hora:    Optional[str] = Field(
        default=None, description="Fecha ISO del ESP32 (YYYY-MM-DD HH:MM:SS)")


class UmbralUpdate(BaseModel):
    minimo: float
    maximo: float

    @model_validator(mode="after")
    def validar_rango(self):
        if self.minimo >= self.maximo:
            raise ValueError(
                "El mínimo debe ser estrictamente menor que el máximo.")
        return self


class UsuarioCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6)
    rol:      str = Field(..., pattern="^(admin|docente|estudiante)$")


class CambiarPassword(BaseModel):
    nueva_password: str = Field(..., min_length=6)


class CalibracionCreate(BaseModel):
    notas: Optional[str] = None


# ─── AUTH: Login ──────────────────────────────────────────────────────────────
@app.post("/api/auth/login", summary="Iniciar sesión")
def login(datos: LoginRequest, response: Response):
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT id, username, password, rol FROM usuarios WHERE username = %s AND activo = TRUE;",
                (datos.username,)
            )
            fila = cursor.fetchone()

        if not fila:
            raise HTTPException(
                status_code=401, detail="Usuario o contraseña incorrectos.")

        _, username, password_hash, rol = fila

        if not bcrypt.checkpw(datos.password.encode(), password_hash.encode()):
            raise HTTPException(
                status_code=401, detail="Usuario o contraseña incorrectos.")

        token = secrets.token_hex(32)
        sesiones[token] = {
            "username": username,
            "rol":      rol,
            "expira":   datetime.now() + timedelta(hours=SESSION_DURATION_HOURS)
        }

        response.set_cookie(
            key="session_token", value=token,
            httponly=True, max_age=SESSION_DURATION_HOURS * 3600, samesite="lax"
        )

        logger.info("Login exitoso: usuario=%s rol=%s", username, rol)
        return {"status": "success", "username": username, "rol": rol}

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error en login: %s", e)
        raise HTTPException(status_code=500, detail=f"Error interno: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── AUTH: Logout ─────────────────────────────────────────────────────────────
@app.post("/api/auth/logout", summary="Cerrar sesión")
def logout(response: Response, session_token: Optional[str] = Cookie(default=None)):
    if session_token and session_token in sesiones:
        del sesiones[session_token]
    response.delete_cookie("session_token")
    return {"status": "success", "mensaje": "Sesión cerrada."}


# ─── AUTH: Info del usuario actual ───────────────────────────────────────────
@app.get("/api/auth/me", summary="Obtener usuario actual")
def get_me(session_token: Optional[str] = Cookie(default=None)):
    usuario = verificar_sesion(session_token)
    if not usuario:
        raise HTTPException(status_code=401, detail="No hay sesión activa.")
    return {"username": usuario["username"], "rol": usuario["rol"]}


# ─── CALIBRACIÓN: Consultar última calibración ────────────────────────────────
@app.get("/api/calibracion", summary="Consultar estado de calibración")
def obtener_calibracion(session_token: Optional[str] = Cookie(default=None)):
    """
    Devuelve la última calibración registrada y si se necesita una nueva.
    Solo relevante para docentes y admins — estudiantes reciben needs_calibration: false.
    """
    usuario = requerir_sesion(session_token)

    # Los estudiantes no necesitan ver esta alerta
    if usuario["rol"] == "estudiante":
        return {"needs_calibration": False}

    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT fecha_calibracion, registrado_por, notas
                FROM calibraciones
                ORDER BY fecha_calibracion DESC
                LIMIT 1;
                """
            )
            fila = cursor.fetchone()

        # Si nunca se registró una calibración, alerta inmediata
        if not fila:
            return {
                "needs_calibration": True,
                "dias_transcurridos": None,
                "ultima_calibracion": None,
                "registrado_por":     None,
                "mensaje": "No hay ninguna calibración registrada en el sistema."
            }

        fecha_calibracion, registrado_por, notas = fila

        # Calcular días transcurridos
        ahora = datetime.now(colombia_tz)
        if fecha_calibracion.tzinfo is None:
            fecha_calibracion = colombia_tz.localize(fecha_calibracion)

        diferencia = ahora - fecha_calibracion
        dias = int(diferencia.total_seconds() / 86400)
        needs_calibration = dias >= DIAS_LIMITE_CALIBRACION

        return {
            "needs_calibration":  needs_calibration,
            "dias_transcurridos": dias,
            "ultima_calibracion": fecha_calibracion.strftime("%Y-%m-%d %H:%M:%S"),
            "registrado_por":     registrado_por,
            "notas":              notas,
            "mensaje": f"Han pasado {dias} día(s) desde la última calibración." if needs_calibration else None
        }

    except Exception as e:
        logger.error("Error al consultar calibración: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── CALIBRACIÓN: Registrar nueva calibración ────────────────────────────────
@app.post("/api/calibracion", status_code=201, summary="Registrar nueva calibración (docentes y admin)")
def registrar_calibracion(
    datos: CalibracionCreate,
    session_token: Optional[str] = Cookie(default=None)
):
    usuario = requerir_docente(session_token)   # docente y admin permitidos
    fecha_colombia = datetime.now(colombia_tz)

    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO calibraciones (fecha_calibracion, registrado_por, notas)
                VALUES (%s, %s, %s) RETURNING id;
                """,
                (fecha_colombia, usuario["username"], datos.notas)
            )
            nuevo_id = cursor.fetchone()[0]
        conexion.commit()
        logger.info("Calibración registrada: id=%s por=%s",
                    nuevo_id, usuario["username"])
        return {
            "status": "success",
            "id": nuevo_id,
            "fecha": fecha_colombia.strftime("%Y-%m-%d %H:%M:%S"),
            "registrado_por": usuario["username"]
        }
    except Exception as e:
        if conexion:
            conexion.rollback()
        logger.error("Error al registrar calibración: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── ADMIN: Listar usuarios ───────────────────────────────────────────────────
@app.get("/api/admin/usuarios", summary="Listar todos los usuarios (solo admin)")
def listar_usuarios(session_token: Optional[str] = Cookie(default=None)):
    requerir_admin(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT id, username, rol, activo FROM usuarios ORDER BY id;")
            filas = cursor.fetchall()
        return [{"id": f[0], "username": f[1], "rol": f[2], "activo": f[3]} for f in filas]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── ADMIN: Crear usuario ─────────────────────────────────────────────────────
@app.post("/api/admin/usuarios", status_code=201, summary="Crear usuario (solo admin)")
def crear_usuario(datos: UsuarioCreate, session_token: Optional[str] = Cookie(default=None)):
    requerir_admin(session_token)
    password_hash = bcrypt.hashpw(
        datos.password.encode(), bcrypt.gensalt(12)).decode()
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "INSERT INTO usuarios (username, password, rol) VALUES (%s, %s, %s) RETURNING id;",
                (datos.username, password_hash, datos.rol)
            )
            nuevo_id = cursor.fetchone()[0]
        conexion.commit()
        return {"status": "success", "id": nuevo_id, "username": datos.username, "rol": datos.rol}
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(
            status_code=409, detail="El nombre de usuario ya existe.")
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── ADMIN: Cambiar contraseña ────────────────────────────────────────────────
@app.put("/api/admin/usuarios/{user_id}/password", summary="Cambiar contraseña (solo admin)")
def cambiar_password(
    user_id: int, datos: CambiarPassword,
    session_token: Optional[str] = Cookie(default=None)
):
    requerir_admin(session_token)
    nuevo_hash = bcrypt.hashpw(
        datos.nueva_password.encode(), bcrypt.gensalt(12)).decode()
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "UPDATE usuarios SET password = %s WHERE id = %s;", (nuevo_hash, user_id))
            if cursor.rowcount == 0:
                raise HTTPException(
                    status_code=404, detail="Usuario no encontrado.")
        conexion.commit()
        return {"status": "success", "mensaje": "Contraseña actualizada correctamente."}
    except HTTPException:
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── ADMIN: Activar/desactivar usuario ───────────────────────────────────────
@app.put("/api/admin/usuarios/{user_id}/activo", summary="Activar o desactivar usuario (solo admin)")
def cambiar_estado(user_id: int, session_token: Optional[str] = Cookie(default=None)):
    admin = requerir_admin(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT username, activo FROM usuarios WHERE id = %s;", (user_id,))
            fila = cursor.fetchone()
            if not fila:
                raise HTTPException(
                    status_code=404, detail="Usuario no encontrado.")
            if fila[0] == admin["username"]:
                raise HTTPException(
                    status_code=400, detail="No puedes desactivarte a ti mismo.")
            nuevo_estado = not fila[1]
            cursor.execute(
                "UPDATE usuarios SET activo = %s WHERE id = %s;", (nuevo_estado, user_id))
        conexion.commit()
        accion = "activado" if nuevo_estado else "desactivado"
        return {"status": "success", "mensaje": f"Usuario {accion} correctamente.", "activo": nuevo_estado}
    except HTTPException:
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── AUTH: Setup inicial ──────────────────────────────────────────────────────
@app.post("/api/auth/setup", include_in_schema=False)
def setup_inicial():
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM usuarios;")
            if cursor.fetchone()[0] > 0:
                raise HTTPException(
                    status_code=400, detail="La tabla ya tiene usuarios.")
            for username, password, rol in [
                ("admin", "admin123", "admin"),
                ("docente", "docente123", "docente"),
                ("estudiante", "estudiante123", "estudiante"),
            ]:
                hash_pw = bcrypt.hashpw(
                    password.encode(), bcrypt.gensalt(12)).decode()
                cursor.execute(
                    "INSERT INTO usuarios (username, password, rol) VALUES (%s, %s, %s);",
                    (username, hash_pw, rol)
                )
        conexion.commit()
        return {"status": "success", "mensaje": "Usuarios por defecto creados."}
    except HTTPException:
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── POST /api/mediciones ─────────────────────────────────────────────────────
@app.post("/api/mediciones", status_code=201, summary="Registrar medición del ESP32")
def guardar_medicion(datos: MedicionESP32):
    # Si el ESP32 envía su propia fecha (datos guardados en SD sin conexión),
    # se usa esa fecha. Si no, se genera la hora actual del servidor.
    if datos.fecha_hora:
        try:
            fecha_colombia = colombia_tz.localize(
                datetime.strptime(datos.fecha_hora, "%Y-%m-%d %H:%M:%S")
            )
        except ValueError:
            fecha_colombia = datetime.now(colombia_tz)
    else:
        fecha_colombia = datetime.now(colombia_tz)

    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "INSERT INTO mediciones (ph, temp_ambiente, temp_agua, fecha_hora) VALUES (%s,%s,%s,%s) RETURNING id;",
                (datos.ph, datos.temp_ambiente, datos.temp_agua, fecha_colombia),
            )
            nuevo_id = cursor.fetchone()[0]
        conexion.commit()
        return {"status": "success", "id": nuevo_id,
                "hora_registrada": fecha_colombia.strftime("%Y-%m-%d %H:%M:%S")}
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=f"Error en BD: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/mediciones/hoy ──────────────────────────────────────────────────
@app.get("/api/mediciones/hoy", summary="Últimas N mediciones válidas del día actual (para gráficas)")
def obtener_mediciones_hoy(
    limite:        int = Query(default=15, ge=1),
    session_token: Optional[str] = Cookie(default=None),
):
    """
    Devuelve las últimas `limite` mediciones del día actual donde al menos
    un sensor tiene un valor válido (no NULL). Usado por las gráficas del dashboard.
    """
    requerir_sesion(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        ahora_colombia = datetime.now(colombia_tz)
        inicio_dia = ahora_colombia.replace(
            hour=0, minute=0, second=0, microsecond=0)

        with conexion.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, ph, temp_ambiente, temp_agua, fecha_hora
                FROM mediciones
                WHERE fecha_hora >= %s
                ORDER BY fecha_hora DESC
                LIMIT %s;
                """,
                (inicio_dia, limite)
            )
            registros = cursor.fetchall()

        return [
            {
                "id":            r[0],
                "ph":            float(r[1]) if r[1] is not None else None,
                "temp_ambiente": float(r[2]) if r[2] is not None else None,
                "temp_agua":     float(r[3]) if r[3] is not None else None,
                "fecha_hora":    r[4].strftime("%Y-%m-%d %H:%M:%S"),
            }
            for r in registros
        ]
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error al consultar BD: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/mediciones ──────────────────────────────────────────────────────
@app.get("/api/mediciones", summary="Consultar mediciones")
def obtener_mediciones(
    limite:        int = Query(default=10, ge=0),
    fecha_inicio:  Optional[str] = Query(default=None),
    fecha_fin:     Optional[str] = Query(default=None),
    session_token: Optional[str] = Cookie(default=None),
):
    requerir_sesion(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            if fecha_inicio and fecha_fin:
                try:
                    dt_inicio = datetime.strptime(
                        fecha_inicio, "%Y-%m-%dT%H:%M")
                    dt_fin = datetime.strptime(fecha_fin,    "%Y-%m-%dT%H:%M")
                except ValueError:
                    raise HTTPException(
                        status_code=400, detail="Formato de fecha inválido.")
                if limite > 0:
                    cursor.execute(
                        "SELECT id,ph,temp_ambiente,temp_agua,fecha_hora FROM mediciones "
                        "WHERE fecha_hora BETWEEN %s AND %s ORDER BY fecha_hora DESC LIMIT %s;",
                        (dt_inicio, dt_fin, limite)
                    )
                else:
                    cursor.execute(
                        "SELECT id,ph,temp_ambiente,temp_agua,fecha_hora FROM mediciones "
                        "WHERE fecha_hora BETWEEN %s AND %s ORDER BY fecha_hora DESC;",
                        (dt_inicio, dt_fin)
                    )
            else:
                if limite > 0:
                    cursor.execute(
                        "SELECT id,ph,temp_ambiente,temp_agua,fecha_hora FROM mediciones "
                        "ORDER BY fecha_hora DESC LIMIT %s;", (limite,)
                    )
                else:
                    cursor.execute(
                        "SELECT id,ph,temp_ambiente,temp_agua,fecha_hora FROM mediciones "
                        "ORDER BY fecha_hora DESC;"
                    )
            registros = cursor.fetchall()
        return [
            {
                "id":            r[0],
                "ph":            float(r[1]) if r[1] is not None else None,
                "temp_ambiente": float(r[2]) if r[2] is not None else None,
                "temp_agua":     float(r[3]) if r[3] is not None else None,
                "fecha_hora":    r[4].strftime("%Y-%m-%d %H:%M:%S")
            }
            for r in registros
        ]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error al consultar BD: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── PUT /api/umbrales/{variable} ─────────────────────────────────────────────
@app.put("/api/umbrales/{variable}", summary="Actualizar umbrales (docentes y admin)")
def actualizar_umbral(
    variable: str, datos: UmbralUpdate,
    session_token: Optional[str] = Cookie(default=None)
):
    requerir_docente(session_token)
    fecha_colombia = datetime.now(colombia_tz)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "UPDATE umbrales SET minimo=%s, maximo=%s, ultima_modificacion=%s WHERE variable=%s;",
                (datos.minimo, datos.maximo, fecha_colombia, variable)
            )
            if cursor.rowcount == 0:
                raise HTTPException(
                    status_code=404, detail="Variable no encontrada.")
        conexion.commit()
        return {"status": "success", "mensaje": f"Límites de '{variable}' actualizados."}
    except HTTPException:
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/umbrales/{variable} ─────────────────────────────────────────────
@app.get("/api/umbrales/{variable}", summary="Consultar umbrales")
def obtener_umbral(
    variable: str,
    session_token: Optional[str] = Cookie(default=None)
):
    # El ESP32 consulta este endpoint sin sesión de navegador.
    # Solo se exige sesión si la petición viene del navegador (tiene token).
    # Si no hay token simplemente se devuelven los umbrales públicamente.
    if session_token:
        requerir_sesion(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT minimo, maximo FROM umbrales WHERE variable=%s;", (variable,))
            resultado = cursor.fetchone()
        if resultado:
            return {"variable": variable, "minimo": float(resultado[0]), "maximo": float(resultado[1])}
        return {"variable": variable, "minimo": 0, "maximo": 30}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/rangos/{variable} ───────────────────────────────────────────────
@app.get("/api/rangos/{variable}", summary="Consultar rango físico válido de un sensor")
def obtener_rango(
    variable: str,
    session_token: Optional[str] = Cookie(default=None)
):
    """
    Devuelve los límites físicos absolutos del sensor (no los umbrales de alerta).
    Se usan en el frontend para validar que los valores ingresados sean posibles.
    """
    requerir_sesion(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT minimo, maximo, unidad FROM rangos_sensor WHERE variable = %s;",
                (variable,)
            )
            resultado = cursor.fetchone()
        if resultado:
            return {
                "variable": variable,
                "minimo":   float(resultado[0]),
                "maximo":   float(resultado[1]),
                "unidad":   resultado[2]
            }
        raise HTTPException(
            status_code=404, detail=f"No se encontró el rango para '{variable}'.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/rangos ──────────────────────────────────────────────────────────
@app.get("/api/rangos", summary="Consultar todos los rangos físicos válidos")
def obtener_todos_rangos(session_token: Optional[str] = Cookie(default=None)):
    requerir_sesion(session_token)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT variable, minimo, maximo, unidad FROM rangos_sensor ORDER BY variable;")
            filas = cursor.fetchall()
        return [
            {"variable": f[0], "minimo": float(
                f[1]), "maximo": float(f[2]), "unidad": f[3]}
            for f in filas
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conexion:
            conexion.close()
