#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <SD.h>
#include <SPI.h>
#include <time.h>

//  CONFIGURACIÓN

const char *SSID = "Andres";
const char *WIFI_PASS = "andf12345";

const char *URL_MEDICIONES = "http://10.140.155.168:8000/api/mediciones";
const char *URL_UMBRALES = "http://10.140.155.168:8000/api/umbrales";

const unsigned long INTERVALO_MEDICION = 5500;
const unsigned long INTERVALO_UMBRALES = 600000UL;

// NTP — servidor de tiempo y zona horaria Colombia (UTC-5)
const char *NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET = -18000; // UTC-5 en segundos
const int DST_OFFSET = 0;

// ── Pines sensores ─────────────────────────────────────────────
#define PIN_DHT 4
#define PIN_DS18B20 5
#define PIN_PH 34

// ── Pines LEDs de validación de sensores ───────────────
#define LED_PH 13
#define LED_TEMP_AMB 14
#define LED_TEMP_AGUA 21

// ── Pin LED de alerta de umbral ────────────────────────────────
#define LED_UMBRAL 27

// ── Pines MicroSD (SPI personalizado) ─────────────────────────
#define SD_MOSI 23
#define SD_MISO 22
#define SD_SCK 25
#define SD_CS 26
#define SD_ARCHIVO "/pendientes.txt"

// ── Sensores instalados físicamente ───────────────────────────
#define SENSOR_PH_INSTALADO true
#define SENSOR_DS18B20_INSTALADO true
#define SENSOR_DHT22_INSTALADO true

// ── Calibración pH ─────────────────────────────────────────────
#define PH_VOLTAJE_7 2.50f
#define PH_VOLTAJE_4 3.05f
#define DHTTYPE DHT22

//  OBJETOS

DHT dht(PIN_DHT, DHTTYPE);
OneWire oneWireBus(PIN_DS18B20);
DallasTemperature ds18b20(&oneWireBus);
SPIClass spiSD(HSPI);

//  VARIABLES GLOBALES

const float SIN_DATO = NAN;

unsigned long ultimaMedicion = 0;
unsigned long ultimoUmbral = 0;
bool sdDisponible = false;
bool ntpSincronizado = false;

struct Umbrales
{
    float ph_min = 6.0f;
    float ph_max = 9.0f;
    float t_amb_min = 15.0f;
    float t_amb_max = 35.0f;
    float t_agua_min = 10.0f;
    float t_agua_max = 40.0f;
    bool cargados = false;
} umbrales;

//  NTP — fecha y hora

// Sincroniza el reloj interno del ESP32 con el servidor NTP.

void sincronizarNTP()
{
    if (WiFi.status() != WL_CONNECTED)
        return;

    configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);

    struct tm info;
    unsigned long inicio = millis();
    while (!getLocalTime(&info) && millis() - inicio < 5000)
    {
        delay(200);
    }

    if (getLocalTime(&info))
    {
        ntpSincronizado = true;
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &info);
        Serial.printf("[NTP] Hora sincronizada: %s\n", buf);
    }
    else
    {
        Serial.println("[NTP] No se pudo sincronizar. Se usará millis() como referencia.");
    }
}

// Devuelve la fecha y hora actual como String "YYYY-MM-DD HH:MM:SS".
// Si el NTP está sincronizado usa la hora real.

String obtenerFechaHora()
{
    if (!ntpSincronizado)
        return "";

    struct tm info;
    if (!getLocalTime(&info))
        return "";

    char buf[32];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &info);
    return String(buf);
}

//  WIFI

void reconectarWiFi()
{
    if (WiFi.status() == WL_CONNECTED)
        return;

    Serial.println("[WiFi] Reconectando...");
    WiFi.disconnect();
    WiFi.begin(SSID, WIFI_PASS);

    unsigned long inicio = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - inicio < 10000)
    {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("\n[WiFi] Reconectado. IP: " + WiFi.localIP().toString());
        // Re-sincronizar NTP al reconectar
        sincronizarNTP();
    }
    else
    {
        Serial.println("\n[WiFi] Sin conexión. Se reintentará en el próximo ciclo.");
    }
}

//  UMBRALES

bool consultarUmbral(const char *variable, float &destMin, float &destMax)
{
    if (WiFi.status() != WL_CONNECTED)
        return false;

    HTTPClient http;
    http.begin(String(URL_UMBRALES) + "/" + variable);
    int code = http.GET();

    if (code == 200)
    {
        String body = http.getString();
        int idxMin = body.indexOf("\"minimo\":") + 9;
        int idxMax = body.indexOf("\"maximo\":") + 9;
        if (idxMin > 9 && idxMax > 9)
        {
            destMin = body.substring(idxMin, body.indexOf(',', idxMin)).toFloat();
            destMax = body.substring(idxMax, body.indexOf('}', idxMax)).toFloat();
            http.end();
            return true;
        }
    }
    http.end();
    return false;
}

void cargarUmbrales()
{
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("[Umbrales] Sin WiFi — usando valores " + String(umbrales.cargados ? "anteriores" : "por defecto"));
        return;
    }

    bool ok = true;
    ok &= consultarUmbral("ph", umbrales.ph_min, umbrales.ph_max);
    ok &= consultarUmbral("temp_ambiente", umbrales.t_amb_min, umbrales.t_amb_max);
    ok &= consultarUmbral("temp_agua", umbrales.t_agua_min, umbrales.t_agua_max);

    if (ok)
    {
        umbrales.cargados = true;
        Serial.printf("[Umbrales] Actualizados — pH:[%.1f-%.1f] T.Amb:[%.1f-%.1f] T.Agua:[%.1f-%.1f]\n",
                      umbrales.ph_min, umbrales.ph_max,
                      umbrales.t_amb_min, umbrales.t_amb_max,
                      umbrales.t_agua_min, umbrales.t_agua_max);
    }
    else
    {
        Serial.println("[Umbrales] Error al cargar — usando valores " + String(umbrales.cargados ? "anteriores" : "por defecto"));
    }
}

//  LEDS

void actualizarLEDsSensores(bool fallo_ph, bool fallo_t_amb, bool fallo_t_agua)
{
    digitalWrite(LED_PH, fallo_ph ? HIGH : LOW);
    digitalWrite(LED_TEMP_AMB, fallo_t_amb ? HIGH : LOW);
    digitalWrite(LED_TEMP_AGUA, fallo_t_agua ? HIGH : LOW);

    Serial.printf("[LEDs] pH:%s | T.Amb:%s | T.Agua:%s\n",
                  fallo_ph ? "FALLO" : "OK",
                  fallo_t_amb ? "FALLO" : "OK",
                  fallo_t_agua ? "FALLO" : "OK");
}

// LED naranja: encendido fijo si cualquier sensor supera su umbral

void actualizarLEDUmbral(float ph, float t_amb, float t_agua)
{
    bool fueraDeRango = false;

    if (!isnan(ph) && (ph < umbrales.ph_min || ph > umbrales.ph_max))
        fueraDeRango = true;
    if (!isnan(t_amb) && (t_amb < umbrales.t_amb_min || t_amb > umbrales.t_amb_max))
        fueraDeRango = true;
    if (!isnan(t_agua) && (t_agua < umbrales.t_agua_min || t_agua > umbrales.t_agua_max))
        fueraDeRango = true;

    digitalWrite(LED_UMBRAL, fueraDeRango ? HIGH : LOW);

    if (fueraDeRango)
        Serial.println("[LED Umbral] ALERTA — valor fuera de rango");
}

//  MICROSD

// Guarda una medición en la SD con su fecha y hora real.

void guardarEnSD(float ph, float t_amb, float t_agua)
{
    if (!sdDisponible)
    {
        Serial.println("[SD] No disponible — medición perdida");
        return;
    }

    auto fmtVal = [](float v) -> String
    {
        return isnan(v) ? "null" : String(v, 2);
    };

    // Usar la fecha/hora real del NTP; si no hay sincronización
    // se guarda cadena vacía y el servidor usará su propia hora
    String fechaHora = obtenerFechaHora();

    String linea = fechaHora + "|" +
                   fmtVal(ph) + "|" +
                   fmtVal(t_amb) + "|" +
                   fmtVal(t_agua) + "\n";

    File f = SD.open(SD_ARCHIVO, FILE_APPEND);
    if (f)
    {
        f.print(linea);
        f.close();
        Serial.println("[SD] Guardado: " + linea);
    }
    else
    {
        Serial.println("[SD] Error al abrir archivo");
    }
}

// Reenvía todas las mediciones guardadas en la SD al servidor
void reenviarDesdeSD()
{
    if (!sdDisponible || !SD.exists(SD_ARCHIVO))
        return;
    if (WiFi.status() != WL_CONNECTED)
        return;

    File f = SD.open(SD_ARCHIVO, FILE_READ);
    if (!f)
    {
        Serial.println("[SD] Error al abrir archivo para reenvío");
        return;
    }

    Serial.println("[SD] Iniciando reenvío de mediciones pendientes...");
    int enviados = 0, errores = 0;

    while (f.available())
    {
        String linea = f.readStringUntil('\n');
        linea.trim();
        if (linea.length() == 0)
            continue;

        // Formato: fecha_hora|ph|t_amb|t_agua
        int sep1 = linea.indexOf('|');
        int sep2 = linea.indexOf('|', sep1 + 1);
        int sep3 = linea.indexOf('|', sep2 + 1);
        if (sep1 < 0 || sep2 < 0 || sep3 < 0)
            continue;

        String sFecha = linea.substring(0, sep1);
        String sPH = linea.substring(sep1 + 1, sep2);
        String sTAmb = linea.substring(sep2 + 1, sep3);
        String sTAgua = linea.substring(sep3 + 1);

        // Construir payload
        String payload = "{\"ph\":" + sPH +
                         ",\"temp_ambiente\":" + sTAmb +
                         ",\"temp_agua\":" + sTAgua;
        if (sFecha.length() > 0)
            payload += ",\"fecha_hora\":\"" + sFecha + "\"";
        payload += "}";

        HTTPClient http;
        http.begin(URL_MEDICIONES);
        http.addHeader("Content-Type", "application/json");
        int code = http.POST(payload);
        http.end();

        if (code == 201)
        {
            enviados++;
        }
        else
        {
            errores++;
            Serial.printf("[SD] Error reenvío (HTTP %d): %s\n", code, payload.c_str());
            break;
        }
    }
    f.close();

    Serial.printf("[SD] Reenvío: %d enviados, %d errores\n", enviados, errores);

    if (errores == 0)
    {
        SD.remove(SD_ARCHIVO);
        Serial.println("[SD] Archivo borrado — SD vacía");
    }
}

//  SENSORES

float leerTemperaturaAmbiente()
{
    if (!SENSOR_DHT22_INSTALADO)
    {
        Serial.println("[DHT22] Sensor no instalado → null");
        return SIN_DATO;
    }
    float temp = dht.readTemperature();
    if (isnan(temp))
    {
        Serial.println("[DHT22] Error de lectura → null");
        return SIN_DATO;
    }
    return temp;
}

float leerTemperaturaAgua()
{
    if (!SENSOR_DS18B20_INSTALADO)
    {
        Serial.println("[DS18B20] Sensor no instalado → null");
        return SIN_DATO;
    }
    ds18b20.requestTemperatures();
    float temp = ds18b20.getTempCByIndex(0);

    if (temp == DEVICE_DISCONNECTED_C || temp <= -126.0f)
    {
        Serial.println("[DS18B20] Error de lectura → null");
        return SIN_DATO;
    }
    return temp;
}

float leerPH()
{
    if (!SENSOR_PH_INSTALADO)
    {
        Serial.println("[pH] Sensor no instalado → null");
        return SIN_DATO;
    }
    const int MUESTRAS = 10;
    long suma = 0;
    for (int i = 0; i < MUESTRAS; i++)
    {
        suma += analogRead(PIN_PH);
        delay(10);
    }
    float voltaje = ((float)suma / MUESTRAS) * (3.3f / 4095.0f);
    float pendiente = (4.0f - 7.0f) / (PH_VOLTAJE_4 - PH_VOLTAJE_7);
    return constrain(7.0f + pendiente * (voltaje - PH_VOLTAJE_7), 0.0f, 14.0f);
}

//  SETUP

void setup()
{
    Serial.begin(115200);

    // ── LEDs ───────────────────────────────────────────────────
    pinMode(LED_PH, OUTPUT);
    digitalWrite(LED_PH, LOW);
    pinMode(LED_TEMP_AMB, OUTPUT);
    digitalWrite(LED_TEMP_AMB, LOW);
    pinMode(LED_TEMP_AGUA, OUTPUT);
    digitalWrite(LED_TEMP_AGUA, LOW);
    pinMode(LED_UMBRAL, OUTPUT);
    digitalWrite(LED_UMBRAL, LOW);

    // ── Sensores ───────────────────────────────────────────────
    dht.begin();
    ds18b20.begin();

    int sensDS = ds18b20.getDeviceCount();
    Serial.printf("[DS18B20] Sensores en el bus: %d\n", sensDS);
    if (sensDS == 0)
        Serial.println("[DS18B20] ADVERTENCIA: Verifica conexión.");

    // ── MicroSD ────────────────────────────────────────────────
    spiSD.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
    if (SD.begin(SD_CS, spiSD, 1000000))
    {
        sdDisponible = true;
        Serial.println("[SD] Inicializada correctamente.");
    }
    else
    {
        Serial.println("[SD] ADVERTENCIA: No se pudo inicializar. Respaldo deshabilitado.");
    }

    // ── WiFi ───────────────────────────────────────────────────
    Serial.println("[WiFi] Conectando...");
    WiFi.begin(SSID, WIFI_PASS);
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < 10000)
    {
        delay(500);
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("\n[WiFi] Conectado. IP: " + WiFi.localIP().toString());
        // Sincronizar hora inmediatamente al conectar
        sincronizarNTP();
    }
    else
    {
        Serial.println("\n[WiFi] Sin conexión inicial.");
    }

    // ── Umbrales ───────────────────────────────────────────────
    cargarUmbrales();
    ultimoUmbral = millis();
}

//  LOOP

void loop()
{
    unsigned long ahora = millis();

    // ── Refresco periódico de umbrales ─────────────────────────
    if (ahora - ultimoUmbral >= INTERVALO_UMBRALES)
    {
        ultimoUmbral = ahora;
        cargarUmbrales();
    }

    // ── Ciclo de medición ──────────────────────────────────────
    if (ahora - ultimaMedicion >= INTERVALO_MEDICION)
    {
        ultimaMedicion = ahora;

        // 1. Leer sensores
        float t_amb = leerTemperaturaAmbiente();
        float t_agua = leerTemperaturaAgua();
        float ph = leerPH();

        // 2. LEDs rojos — fallo de sensor
        actualizarLEDsSensores(isnan(ph), isnan(t_amb), isnan(t_agua));

        // 3. LED naranja — alerta de umbral (encendido fijo, sin delay)
        actualizarLEDUmbral(ph, t_amb, t_agua);

        // 4. Intentar reconectar WiFi si es necesario
        reconectarWiFi();

        // 5. Preparar payload con fecha/hora actual
        auto fmtVal = [](float v) -> String
        {
            return isnan(v) ? "null" : String(v, 2);
        };

        String fechaHora = obtenerFechaHora();

        String payload = "{\"ph\":" + fmtVal(ph) +
                         ",\"temp_ambiente\":" + fmtVal(t_amb) +
                         ",\"temp_agua\":" + fmtVal(t_agua);
        if (fechaHora.length() > 0)
            payload += ",\"fecha_hora\":\"" + fechaHora + "\"";
        payload += "}";

        if (WiFi.status() == WL_CONNECTED)
        {
            // 6a. WiFi disponible: reenviar pendientes SD, luego enviar actual
            reenviarDesdeSD();

            HTTPClient http;
            http.begin(URL_MEDICIONES);
            http.addHeader("Content-Type", "application/json");
            int codigo = http.POST(payload);
            http.end();

            if (codigo == 201)
            {
                Serial.printf("[HTTP] OK | %s | pH:%s T_amb:%s T_agua:%s\n",
                              fechaHora.c_str(),
                              fmtVal(ph).c_str(), fmtVal(t_amb).c_str(), fmtVal(t_agua).c_str());
            }
            else
            {
                // WiFi activo pero servidor caído → guardar en SD
                Serial.printf("[HTTP] Error (%d) → guardando en SD\n", codigo);
                guardarEnSD(ph, t_amb, t_agua);
            }
        }
        else
        {
            // 6b. Sin WiFi → guardar en SD con fecha/hora actual
            Serial.println("[WiFi] Sin conexión — guardando en SD");
            guardarEnSD(ph, t_amb, t_agua);
        }
    }
}