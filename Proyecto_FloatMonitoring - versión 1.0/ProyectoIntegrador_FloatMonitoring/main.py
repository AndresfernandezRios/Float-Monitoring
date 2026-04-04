from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import psycopg2
from datetime import datetime
import pytz
from fastapi.middleware.cors import CORSMiddleware

# 1. Configuración de la aplicación
app = FastAPI(title="API Float Monitoring", version="1.0")

# Se le asignan permisos a la API para enviar datos a la interfaz
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Esto permite que cualquier pagina pueda acceder
    allow_methods=["*"],
    allow_headers=["*"],
)


# Zona horaria de Colombia (Popayán)
colombia_tz = pytz.timezone('America/Bogota')

# 2. Configuración de conexión
DB_CONFIG = {
    "dbname": "postgres",
    "user": "postgres",
    "password": "XXXXXXXXX",
    "host": "localhost",
    "port": "5432"
}

# 3. Modelo de datos para el ESP32 (Tarea 5: Formato de datos)


class MedicionESP32(BaseModel):
    ph: float
    temp_ambiente: float
    temp_agua: float


def obtener_conexion():
    return psycopg2.connect(**DB_CONFIG)

# 4. Endpoint para recibir datos


@app.post("/api/mediciones", status_code=201)
def guardar_medicion(datos: MedicionESP32):
    # Generamos la hora actual de Colombia
    fecha_colombia = datetime.now(colombia_tz)

    conexion = None
    try:
        conexion = obtener_conexion()
        cursor = conexion.cursor()

        query = """
            INSERT INTO mediciones (ph, temp_ambiente, temp_agua, fecha_hora) 
            VALUES (%s, %s, %s, %s) RETURNING id;
        """
        cursor.execute(query, (datos.ph, datos.temp_ambiente,
                       datos.temp_agua, fecha_colombia))

        nuevo_id = cursor.fetchone()[0]
        conexion.commit()

        cursor.close()
        return {
            "status": "success",
            "id": nuevo_id,
            "hora_registrada": fecha_colombia.strftime("%Y-%m-%d %H:%M:%S")
        }

    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(status_code=500, detail=f"Error en BD: {str(e)}")

    finally:
        if conexion:
            conexion.close()

# 5. Endpoint para consultar datos


@app.get("/api/mediciones")
def obtener_mediciones(limite: int = 0):
    conexion = None
    try:
        conexion = obtener_conexion()
        cursor = conexion.cursor()

        # Consultamos las últimas mediciones ordenadas desde la más reciente
        query = """
            SELECT id, ph, temp_ambiente, temp_agua, fecha_hora 
            FROM mediciones 
            ORDER BY fecha_hora DESC 
            LIMIT %s;
        """
        # Le pasamos el límite (por defecto 10 registros)
        cursor.execute(query, (limite,))
        registros = cursor.fetchall()

        # Convertimos la respuesta de Postgres a un formato amigable para la web (JSON)
        lista_mediciones = []
        for fila in registros:
            lista_mediciones.append({
                "id": fila[0],
                "ph": float(fila[1]),
                "temp_ambiente": float(fila[2]),
                "temp_agua": float(fila[3]),
                # Formato limpio
                "fecha_hora": fila[4].strftime("%Y-%m-%d %H:%M:%S")
            })

        cursor.close()
        return lista_mediciones

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error al consultar BD: {str(e)}")

    finally:
        if conexion:
            conexion.close()

# 6. Modelo de datos para actualizar umbrales


class UmbralUpdate(BaseModel):
    minimo: float
    maximo: float

# 7. Endpoint para modificar un umbral específico


@app.put("/api/umbrales/{variable}")
def actualizar_umbral(variable: str, datos: UmbralUpdate):
    # REGLA (HU14): El mínimo no puede ser mayor o igual al máximo
    if datos.minimo >= datos.maximo:
        raise HTTPException(
            status_code=400, detail="Error: El valor mínimo debe ser estrictamente menor que el máximo.")

    fecha_colombia = datetime.now(colombia_tz)
    conexion = None

    try:
        conexion = obtener_conexion()
        cursor = conexion.cursor()

        # Actualizamos la variable (ph, temp_ambiente o temp_agua)
        query = """
            UPDATE umbrales 
            SET minimo = %s, maximo = %s, ultima_modificacion = %s 
            WHERE variable = %s;
        """
        cursor.execute(query, (datos.minimo, datos.maximo,
                       fecha_colombia, variable))

        # Verificamos si la variable realmente existía en la base de datos
        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=404, detail="Variable no encontrada. Usa 'ph', 'temp_ambiente' o 'temp_agua'.")

        conexion.commit()
        cursor.close()

        return {
            "status": "success",
            "mensaje": f"Los límites de '{variable}' se actualizaron correctamente."
        }

    except HTTPException:
        # Si es un error de validación nuestro (400 o 404), lo dejamos pasar tal cual
        raise
    except Exception as e:
        if conexion:
            conexion.rollback()
        raise HTTPException(
            status_code=500, detail=f"Error interno del servidor: {str(e)}")

    finally:
        if conexion:
            conexion.close()

# 8. Endpoint para consultar un umbral específico


@app.get("/api/umbrales/{variable}")
def obtener_umbral(variable: str):
    conexion = None
    try:
        conexion = obtener_conexion()
        cursor = conexion.cursor()

        # Buscamos los límites en la tabla 'umbrales'
        query = "SELECT minimo, maximo FROM umbrales WHERE variable = %s;"
        cursor.execute(query, (variable,))
        resultado = cursor.fetchone()

        if resultado:
            return {
                "variable": variable,
                "minimo": float(resultado[0]),
                "maximo": float(resultado[1])
            }
        else:
            # Si la variable no existe, devolvemos un rango por defecto para no romper el JS
            return {"variable": variable, "minimo": 0, "maximo": 30}

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Error al consultar umbrales: {str(e)}")
    finally:
        if conexion:
            conexion.close()
