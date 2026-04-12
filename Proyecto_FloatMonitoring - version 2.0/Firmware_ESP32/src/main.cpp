#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>

// --- DATOS DE RED Y API ---
const char *ssid = "Andres";
const char *password = "andf12345";
const char *serverName = "http://10.199.140.168:8000/api/mediciones";

// --- PINES ---
#define DHTPIN 4
#define DHTTYPE DHT22

DHT dht(DHTPIN, DHTTYPE);

void setup()
{
    Serial.begin(115200);
    dht.begin();

    WiFi.begin(ssid, password);
    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Conectado");
}

void loop()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        HTTPClient http;

        // 1. Lectura REAL del DHT22
        float t_amb = dht.readTemperature();

        // Si el sensor falla, envía un valor por defecto para no romper el programa
        if (isnan(t_amb))
        {
            Serial.println("Fallo al leer el DHT22");
            t_amb = 0.0;
        }

        // Lecturas FALSAS para los sensores que aún no tienes
        float t_agua = 0.0;
        float ph_val = 0.0;

        // 2. Construir JSON
        String jsonPayload = "{\"ph\": " + String(ph_val) +
                             ", \"temp_ambiente\": " + String(t_amb) +
                             ", \"temp_agua\": " + String(t_agua) + "}";

        // 3. Envío POST
        http.begin(serverName);
        http.addHeader("Content-Type", "application/json");

        int httpResponseCode = http.POST(jsonPayload);

        if (httpResponseCode > 0)
        {
            Serial.printf("Enviado. Respuesta Servidor: %d\n", httpResponseCode);
        }
        else
        {
            Serial.printf("Error en envío: %s\n", http.errorToString(httpResponseCode).c_str());
        }
        http.end();
    }
    delay(5000);
}