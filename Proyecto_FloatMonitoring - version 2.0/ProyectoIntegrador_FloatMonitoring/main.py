import logging
import os
from datetime import datetime
from typing import Optional

import psycopg2
import pytz
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from dotenv import load_dotenv
load_dotenv()
# ─── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── Zona horaria ─────────────────────────────────────────────────────────────
colombia_tz = pytz.timezone("America/Bogota")

# ─── Configuración de BD desde variables de entorno ──────────────────────────
# En desarrollo puedes crear un archivo .env con estas variables.
# NUNCA pongas la contraseña directamente en el código fuente.
DB_CONFIG = {
    "dbname":   os.getenv("DB_NAME",     "postgres"),
    "user":     os.getenv("DB_USER",     "postgres"),
    # export DB_PASSWORD=tu_contraseña
    "password": os.getenv("DB_PASSWORD", ""),
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     os.getenv("DB_PORT",     "5432"),
}


def obtener_conexion():
    """Abre y devuelve una conexión nueva a PostgreSQL."""
    return psycopg2.connect(**DB_CONFIG)


# ─── Una sola instancia de FastAPI ───────────────────────────────────────────
# CORRECCIÓN: antes había dos app = FastAPI(...), la segunda sobreescribía
# la primera y dejaba huérfanos el mount de /static y las rutas de HTML.
app = FastAPI(title="API Float Monitoring", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # En producción cambia esto por tu dominio real
    allow_methods=["*"],
    allow_headers=["*"],
)

# El mount debe ir DESPUÉS de crear app y ANTES de definir rutas
app.mount("/static", StaticFiles(directory="static"), name="static")


# ─── Rutas HTML ──────────────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
@app.get("/dashboard", include_in_schema=False)
async def get_dashboard():
    return FileResponse("index.html")


@app.get("/consultas", include_in_schema=False)
async def get_consultas():
    return FileResponse("consultas.html")


# ─── Modelos de datos ────────────────────────────────────────────────────────
class MedicionESP32(BaseModel):
    ph:            float = Field(..., ge=0.0,
                                 le=14.0,  description="pH del agua (0–14)")
    temp_ambiente: float = Field(..., ge=-10.0, le=60.0,
                                 description="Temperatura ambiente en °C")
    temp_agua:     float = Field(..., ge=0.0,   le=100.0,
                                 description="Temperatura del agua en °C")


class UmbralUpdate(BaseModel):
    minimo: float
    maximo: float

    # MEJORA: la validación vive en el modelo, no en el endpoint
    @model_validator(mode="after")
    def validar_rango(self):
        if self.minimo >= self.maximo:
            raise ValueError(
                "El mínimo debe ser estrictamente menor que el máximo.")
        return self


# ─── POST /api/mediciones ────────────────────────────────────────────────────
@app.post("/api/mediciones", status_code=201, summary="Registrar medición del ESP32")
def guardar_medicion(datos: MedicionESP32):
    fecha_colombia = datetime.now(colombia_tz)
    conexion = None
    try:
        conexion = obtener_conexion()
        # CORRECCIÓN: 'with cursor' garantiza que el cursor se cierra aunque haya excepción
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO mediciones (ph, temp_ambiente, temp_agua, fecha_hora)
                VALUES (%s, %s, %s, %s) RETURNING id;
                """,
                (datos.ph, datos.temp_ambiente, datos.temp_agua, fecha_colombia),
            )
            nuevo_id = cursor.fetchone()[0]
        conexion.commit()
        logger.info("Medición guardada: id=%s", nuevo_id)
        return {
            "status": "success",
            "id": nuevo_id,
            "hora_registrada": fecha_colombia.strftime("%Y-%m-%d %H:%M:%S"),
        }
    except Exception as e:
        if conexion:
            conexion.rollback()
        logger.error("Error al guardar medición: %s", e)
        raise HTTPException(status_code=500, detail=f"Error en BD: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/mediciones ─────────────────────────────────────────────────────
@app.get("/api/mediciones", summary="Consultar mediciones")
def obtener_mediciones(
    limite: int = Query(
        default=10, ge=0, description="Cantidad de registros. 0 = todos."),
    fecha_inicio: Optional[str] = Query(
        default=None, description="Desde (formato: YYYY-MM-DDTHH:MM)"),
    fecha_fin:    Optional[str] = Query(
        default=None, description="Hasta  (formato: YYYY-MM-DDTHH:MM)"),
):
    """
    Devuelve mediciones ordenadas de más reciente a más antigua.
    - Sin parámetros: últimos 10 registros.
    - Con `fecha_inicio` y `fecha_fin`: filtra por rango de fechas.
    - Con `limite=0`: devuelve todos los registros (sin filtro de cantidad).
    """
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:

            # ── Caso 1: filtro por rango de fechas ──────────────────────────
            if fecha_inicio and fecha_fin:
                try:
                    # Acepta el formato que manda el input datetime-local del HTML
                    dt_inicio = datetime.strptime(
                        fecha_inicio, "%Y-%m-%dT%H:%M")
                    dt_fin = datetime.strptime(fecha_fin,    "%Y-%m-%dT%H:%M")
                except ValueError:
                    raise HTTPException(
                        status_code=400,
                        detail="Formato de fecha inválido. Usa YYYY-MM-DDTHH:MM"
                    )

                query = """
                    SELECT id, ph, temp_ambiente, temp_agua, fecha_hora
                    FROM mediciones
                    WHERE fecha_hora BETWEEN %s AND %s
                    ORDER BY fecha_hora DESC
                """
                params = (dt_inicio, dt_fin)

                # Aplicar límite también al filtro si se especificó
                if limite > 0:
                    query += " LIMIT %s"
                    params = (dt_inicio, dt_fin, limite)

                cursor.execute(query, params)

            # ── Caso 2: sin filtro de fechas, solo límite ───────────────────
            else:
                if limite > 0:
                    cursor.execute(
                        """
                        SELECT id, ph, temp_ambiente, temp_agua, fecha_hora
                        FROM mediciones
                        ORDER BY fecha_hora DESC
                        LIMIT %s;
                        """,
                        (limite,),
                    )
                else:
                    # limite=0 → todos los registros
                    cursor.execute(
                        """
                        SELECT id, ph, temp_ambiente, temp_agua, fecha_hora
                        FROM mediciones
                        ORDER BY fecha_hora DESC;
                        """
                    )

            registros = cursor.fetchall()

        return [
            {
                "id":            fila[0],
                "ph":            float(fila[1]),
                "temp_ambiente": float(fila[2]),
                "temp_agua":     float(fila[3]),
                "fecha_hora":    fila[4].strftime("%Y-%m-%d %H:%M:%S"),
            }
            for fila in registros
        ]

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error al consultar mediciones: %s", e)
        raise HTTPException(
            status_code=500, detail=f"Error al consultar BD: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── PUT /api/umbrales/{variable} ────────────────────────────────────────────
@app.put("/api/umbrales/{variable}", summary="Actualizar umbrales de alerta")
def actualizar_umbral(variable: str, datos: UmbralUpdate):
    # La validación minimo < maximo ya la hace el modelo UmbralUpdate
    fecha_colombia = datetime.now(colombia_tz)
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                """
                UPDATE umbrales
                SET minimo = %s, maximo = %s, ultima_modificacion = %s
                WHERE variable = %s;
                """,
                (datos.minimo, datos.maximo, fecha_colombia, variable),
            )
            if cursor.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail="Variable no encontrada. Usa 'ph', 'temp_ambiente' o 'temp_agua'.",
                )
        conexion.commit()
        logger.info("Umbral actualizado: variable=%s", variable)
        return {
            "status":  "success",
            "mensaje": f"Los límites de '{variable}' se actualizaron correctamente.",
        }
    except HTTPException:
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        logger.error("Error al actualizar umbral: %s", e)
        raise HTTPException(status_code=500, detail=f"Error interno: {e}")
    finally:
        if conexion:
            conexion.close()


# ─── GET /api/umbrales/{variable} ────────────────────────────────────────────
@app.get("/api/umbrales/{variable}", summary="Consultar umbrales de alerta")
def obtener_umbral(variable: str):
    conexion = None
    try:
        conexion = obtener_conexion()
        with conexion.cursor() as cursor:
            cursor.execute(
                "SELECT minimo, maximo FROM umbrales WHERE variable = %s;",
                (variable,),
            )
            resultado = cursor.fetchone()

        if resultado:
            return {
                "variable": variable,
                "minimo":   float(resultado[0]),
                "maximo":   float(resultado[1]),
            }
        # Fallback si la variable no existe, para no romper el JS
        return {"variable": variable, "minimo": 0, "maximo": 30}

    except Exception as e:
        logger.error("Error al consultar umbral: %s", e)
        raise HTTPException(
            status_code=500, detail=f"Error al consultar umbrales: {e}")
    finally:
        if conexion:
            conexion.close()
