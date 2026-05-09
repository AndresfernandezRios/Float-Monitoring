#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ═══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

const char *SSID = "Jordi_Fernandez";
const char *WIFI_PASS = "Michin76";
const char *SERVER_URL = "http://192.168.1.15:8000/api/mediciones";

const unsigned long INTERVALO_ENVIO = 5000; // ms entre envíos

// ── Pines sensores ─────────────────────────────────────────────
#define PIN_DHT 4     // DHT22   — temperatura ambiente
#define PIN_DS18B20 5 // DS18B20 — temperatura agua (+ 4.7kΩ a 3.3V)
#define PIN_PH 34     // Módulo pH analógico (solo lectura)

// ── HU_3: Pines LEDs de validación ────────────────────────────
#define LED_PH 18        // LED rojo — sensor pH
#define LED_TEMP_AMB 19  // LED rojo — sensor temperatura ambiente (DHT22)
#define LED_TEMP_AGUA 21 // LED rojo — sensor temperatura agua (DS18B20)

// ── Sensores instalados físicamente ───────────────────────────
// Cambia a true cuando conectes físicamente el sensor.
// Si está en false → envía null al servidor y enciende su LED de fallo.
#define SENSOR_PH_INSTALADO false // ← cambiar a true cuando llegue el sensor
#define SENSOR_DS18B20_INSTALADO true
#define SENSOR_DHT22_INSTALADO true

// ── Calibración pH ─────────────────────────────────────────────
#define PH_VOLTAJE_7 2.50
#define PH_VOLTAJE_4 3.05

#define DHTTYPE DHT22

// ═══════════════════════════════════════════════════════════════
//  OBJETOS
// ═══════════════════════════════════════════════════════════════
DHT dht(PIN_DHT, DHTTYPE);
OneWire oneWireBus(PIN_DS18B20);
DallasTemperature ds18b20(&oneWireBus);

// ═══════════════════════════════════════════════════════════════
//  VARIABLES GLOBALES
// ═══════════════════════════════════════════════════════════════
unsigned long ultimoEnvio = 0;
const float SIN_DATO = NAN;

// ═══════════════════════════════════════════════════════════════
//  FUNCIONES AUXILIARES
// ═══════════════════════════════════════════════════════════════

void reconectarWiFi()
{
    if (WiFi.status() == WL_CONNECTED)
        return;

    Serial.println("[WiFi] Conexión perdida. Reconectando...");
    WiFi.disconnect();
    WiFi.begin(SSID, WIFI_PASS);

    unsigned long inicio = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - inicio < 10000)
    {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED)
        Serial.println("\n[WiFi] Reconectado. IP: " + WiFi.localIP().toString());
    else
        Serial.println("\n[WiFi] No se pudo reconectar. Se reintentará en el próximo ciclo.");
}

void actualizarLEDs(bool fallo_ph, bool fallo_t_amb, bool fallo_t_agua)
{
    digitalWrite(LED_PH, fallo_ph ? HIGH : LOW);
    digitalWrite(LED_TEMP_AMB, fallo_t_amb ? HIGH : LOW);
    digitalWrite(LED_TEMP_AGUA, fallo_t_agua ? HIGH : LOW);

    Serial.printf("[LEDs] pH:%s | T.Amb:%s | T.Agua:%s\n",
                  fallo_ph ? "FALLO" : "OK",
                  fallo_t_amb ? "FALLO" : "OK",
                  fallo_t_agua ? "FALLO" : "OK");
}

float leerTemperaturaAmbiente()
{
    if (!SENSOR_DHT22_INSTALADO)
    {
        Serial.println("[DHT22] Sensor no instalado → se enviará null");
        return SIN_DATO;
    }
    float temp = dht.readTemperature();
    if (isnan(temp))
    {
        Serial.println("[DHT22] Error de lectura → se enviará null");
        return SIN_DATO;
    }
    return temp;
}

float leerTemperaturaAgua()
{
    if (!SENSOR_DS18B20_INSTALADO)
    {
        Serial.println("[DS18B20] Sensor no instalado → se enviará null");
        return SIN_DATO;
    }
    ds18b20.requestTemperatures();
    float temp = ds18b20.getTempCByIndex(0);

    if (temp == DEVICE_DISCONNECTED_C || temp <= -126.0)
    {
        Serial.println("[DS18B20] Error de lectura → se enviará null");
        return SIN_DATO;
    }
    return temp;
}

float leerPH()
{
    // Si el sensor no está instalado → null y LED de fallo encendido
    if (!SENSOR_PH_INSTALADO)
    {
        Serial.println("[pH] Sensor no instalado → se enviará null");
        return SIN_DATO;
    }

    const int MUESTRAS = 10;
    long suma = 0;
    for (int i = 0; i < MUESTRAS; i++)
    {
        suma += analogRead(PIN_PH);
        delay(10);
    }
    float lecturaADC = (float)suma / MUESTRAS;
    float voltaje = lecturaADC * (3.3f / 4095.0f);

    float pendiente = (4.0f - 7.0f) / (PH_VOLTAJE_4 - PH_VOLTAJE_7);
    float ph = 7.0f + pendiente * (voltaje - PH_VOLTAJE_7);

    return constrain(ph, 0.0f, 14.0f);
}

void enviarMedicion(float ph, float t_amb, float t_agua)
{
    reconectarWiFi();
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("[HTTP] Sin WiFi, envío cancelado.");
        return;
    }

    auto fmtVal = [](float v) -> String
    {
        return isnan(v) ? "null" : String(v, 2);
    };

    String payload = "{\"ph\":" + fmtVal(ph) +
                     ",\"temp_ambiente\":" + fmtVal(t_amb) +
                     ",\"temp_agua\":" + fmtVal(t_agua) + "}";

    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");

    int codigo = http.POST(payload);

    if (codigo > 0)
        Serial.printf("[HTTP] OK (%d) | pH:%s T_amb:%s T_agua:%s\n",
                      codigo,
                      isnan(ph) ? "null" : String(ph, 2).c_str(),
                      isnan(t_amb) ? "null" : String(t_amb, 2).c_str(),
                      isnan(t_agua) ? "null" : String(t_agua, 2).c_str());
    else
        Serial.printf("[HTTP] Error: %s\n", http.errorToString(codigo).c_str());

    http.end();
}

// ═══════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════
void setup()
{
    Serial.begin(115200);

    pinMode(LED_PH, OUTPUT);
    digitalWrite(LED_PH, LOW);
    pinMode(LED_TEMP_AMB, OUTPUT);
    digitalWrite(LED_TEMP_AMB, LOW);
    pinMode(LED_TEMP_AGUA, OUTPUT);
    digitalWrite(LED_TEMP_AGUA, LOW);

    dht.begin();
    ds18b20.begin();

    Serial.println("[WiFi] Conectando...");
    WiFi.begin(SSID, WIFI_PASS);
    while (WiFi.status() != WL_CONNECTED)
    {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n[WiFi] Conectado. IP: " + WiFi.localIP().toString());

    int sensoresEncontrados = ds18b20.getDeviceCount();
    Serial.printf("[DS18B20] Sensores en el bus: %d\n", sensoresEncontrados);
    if (sensoresEncontrados == 0)
        Serial.println("[DS18B20] ADVERTENCIA: Verifica conexión y resistencia 4.7kΩ.");
}

// ═══════════════════════════════════════════════════════════════
//  LOOP
// ═══════════════════════════════════════════════════════════════
void loop()
{
    unsigned long ahora = millis();

    if (ahora - ultimoEnvio >= INTERVALO_ENVIO)
    {
        ultimoEnvio = ahora;

        float t_amb = leerTemperaturaAmbiente();
        float t_agua = leerTemperaturaAgua();
        float ph = leerPH();

        // isnan() detecta tanto fallo de sensor como sensor no instalado
        bool fallo_ph = isnan(ph);
        bool fallo_t_amb = isnan(t_amb);
        bool fallo_t_agua = isnan(t_agua);
        actualizarLEDs(fallo_ph, fallo_t_amb, fallo_t_agua);

        enviarMedicion(ph, t_amb, t_agua);
    }
}