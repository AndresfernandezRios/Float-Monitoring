import requests
import time
import random

API_URL = "http://localhost:8000/api/mediciones"

print(" Iniciando simulación de sensores...")

while True:
    # Generamos datos realistas
    datos = {
        "ph": round(random.uniform(6.5, 8.5), 2),
        "temp_ambiente": round(random.uniform(22.0, 26.0), 1),
        "temp_agua": round(random.uniform(18.0, 21.0), 1)
    }

    try:
        response = requests.post(API_URL, json=datos)
        print(f"Enviado: {datos} - Status: {response.status_code}")
    except Exception as e:
        print(f"Error: El servidor está apagado")

    time.sleep(3)  # Espera 3 segundos para el próximo envío
