#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <SD.h>
#include <SPI.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_pm.h"   // Power Management + Light Sleep
#include "esp_wifi.h" // WiFi modem sleep

// ═══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

const char *SSID = "Jordi_Fernandez";
const char *WIFI_PASS = "Michin76";
const char *URL_MEDICIONES = "http://192.168.1.15:8000/api/mediciones";
const char *URL_UMBRALES = "http://192.168.1.15:8000/api/umbrales";

// Intervalo de medición: 10 minutos = 600 000 ms
const TickType_t INTERVALO_MEDICION_MS = pdMS_TO_TICKS(600000UL);

// Intervalo de refresco de umbrales: 30 segundos
const TickType_t INTERVALO_UMBRALES_MS = pdMS_TO_TICKS(30000UL);

// Intervalo del parpadeo del LED naranja: 500 ms
const TickType_t INTERVALO_PARPADEO_MS = pdMS_TO_TICKS(500UL);

// NTP
const char *NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET = -18000; // UTC-5 Colombia
const int DST_OFFSET = 0;

// ── Pines sensores ─────────────────────────────────────────────
#define PIN_DHT 4
#define PIN_DS18B20 5
#define PIN_PH 34

// ── Pines LEDs ─────────────────────────────────────────────────
#define LED_PH 13        // rojo  — fallo sensor pH
#define LED_TEMP_AMB 14  // rojo  — fallo sensor DHT22
#define LED_TEMP_AGUA 21 // rojo  — fallo sensor DS18B20
#define LED_UMBRAL 27    // naranja — alerta umbral / sensor null

// ── Pines MicroSD ──────────────────────────────────────────────
#define SD_MOSI 23
#define SD_MISO 22
#define SD_SCK 25
#define SD_CS 26
#define SD_ARCHIVO "/pendientes.txt"

// ── Sensores instalados ────────────────────────────────────────
#define SENSOR_PH_INSTALADO true
#define SENSOR_DS18B20_INSTALADO true
#define SENSOR_DHT22_INSTALADO true

// ── Calibración pH ─────────────────────────────────────────────
#define PH_VOLTAJE_7 2.50f
#define PH_VOLTAJE_4 3.05f
#define DHTTYPE DHT22

// ═══════════════════════════════════════════════════════════════
//  OBJETOS DE HARDWARE
// ═══════════════════════════════════════════════════════════════
DHT dht(PIN_DHT, DHTTYPE);
OneWire oneWireBus(PIN_DS18B20);
DallasTemperature ds18b20(&oneWireBus);
SPIClass spiSD(HSPI);

// ═══════════════════════════════════════════════════════════════
//  ESTADO COMPARTIDO
// ═══════════════════════════════════════════════════════════════
SemaphoreHandle_t xMutexDatos;
SemaphoreHandle_t xMutexSD;

struct Lectura
{
    float ph = NAN;
    float t_amb = NAN;
    float t_agua = NAN;
    // El flag 'nueva' fue eliminado: reemplazado por xTaskNotifyGive/Take,
    // que es más eficiente para Light Sleep porque tarea_comunicacion
    // no necesita su propio timer independiente.
} ultimaLectura;

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

bool sdDisponible = false;
bool ntpSincronizado = false;

// ═══════════════════════════════════════════════════════════════
//  POWER MANAGEMENT — Locks de Light Sleep
// ═══════════════════════════════════════════════════════════════
//
//  ESP_PM_NO_LIGHT_SLEEP  →  impide que el CPU entre en Light Sleep
//  durante la ventana en que se sostiene el lock. Necesario para
//  DS18B20 (1-Wire) y DHT22: ambos protocolos dependen de pulsos
//  con resolución de microsegundos; si el CPU se suspende a mitad
//  de una trama, el sensor reporta NAN o datos basura.
//
//  ESP_PM_APB_FREQ_MAX  →  fija el bus APB (Advanced Peripheral Bus)
//  a su frecuencia máxima. El stack WiFi/TCP necesita esta estabilidad
//  durante transmisiones HTTP; bajar APB en medio de una conexión
//  activa puede causar timeouts o paquetes malformados.
//
esp_pm_lock_handle_t xLockSensores = NULL; // NO_LIGHT_SLEEP
esp_pm_lock_handle_t xLockHTTP = NULL;     // APB_FREQ_MAX

// ── Handle de tarea_comunicacion ──────────────────────────────
// tarea_sensores llama a xTaskNotifyGive(xHandleComunic) en lugar
// de usar un flag compartido. Así tarea_comunicacion duerme en
// ulTaskNotifyTake(portMAX_DELAY) sin consumir CPU ni timer ticks.
// Debe declararse aquí (scope global) para ser visible desde ambas
// tareas, y debe crearse ANTES de xTaskCreate de tarea_sensores.
TaskHandle_t xHandleComunic = NULL;

// ═══════════════════════════════════════════════════════════════
//  UTILIDADES COMUNES
// ═══════════════════════════════════════════════════════════════

String fmtVal(float v)
{
    return isnan(v) ? "null" : String(v, 2);
}

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

// ═══════════════════════════════════════════════════════════════
//  WIFI Y NTP
// ═══════════════════════════════════════════════════════════════
void sincronizarNTP()
{
    if (WiFi.status() != WL_CONNECTED)
        return;
    configTime(GMT_OFFSET, DST_OFFSET, NTP_SERVER);
    struct tm info;
    unsigned long inicio = millis();
    while (!getLocalTime(&info) && millis() - inicio < 5000)
        vTaskDelay(pdMS_TO_TICKS(200));
    if (getLocalTime(&info))
    {
        ntpSincronizado = true;
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &info);
        Serial.printf("[NTP] Sincronizado: %s\n", buf);
    }
    else
    {
        Serial.println("[NTP] Sin sincronización.");
    }
}

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
        vTaskDelay(pdMS_TO_TICKS(500));
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("\n[WiFi] Conectado. IP: " + WiFi.localIP().toString());
        sincronizarNTP();
    }
    else
    {
        Serial.println("\n[WiFi] Sin conexión.");
    }
}

// ═══════════════════════════════════════════════════════════════
//  MICROSD
// ═══════════════════════════════════════════════════════════════
void guardarEnSD(float ph, float t_amb, float t_agua)
{
    if (!sdDisponible)
    {
        Serial.println("[SD] No disponible.");
        return;
    }
    xSemaphoreTake(xMutexSD, portMAX_DELAY);
    String linea = obtenerFechaHora() + "|" +
                   fmtVal(ph) + "|" + fmtVal(t_amb) + "|" + fmtVal(t_agua) + "\n";
    File f = SD.open(SD_ARCHIVO, FILE_APPEND);
    if (f)
    {
        f.print(linea);
        f.close();
        Serial.println("[SD] Guardado: " + linea);
    }
    else
    {
        Serial.println("[SD] Error al abrir archivo.");
    }
    xSemaphoreGive(xMutexSD);
}

void reenviarDesdeSD()
{
    // Precondición: xLockHTTP ya está adquirido por el llamador.
    if (!sdDisponible || !SD.exists(SD_ARCHIVO))
        return;
    if (WiFi.status() != WL_CONNECTED)
        return;

    xSemaphoreTake(xMutexSD, portMAX_DELAY);
    File f = SD.open(SD_ARCHIVO, FILE_READ);
    if (!f)
    {
        xSemaphoreGive(xMutexSD);
        return;
    }

    Serial.println("[SD] Reenviando mediciones pendientes...");
    int enviados = 0, errores = 0;

    while (f.available())
    {
        String linea = f.readStringUntil('\n');
        linea.trim();
        if (linea.length() == 0)
            continue;

        int s1 = linea.indexOf('|'),
            s2 = linea.indexOf('|', s1 + 1),
            s3 = linea.indexOf('|', s2 + 1);
        if (s1 < 0 || s2 < 0 || s3 < 0)
            continue;

        String sFecha = linea.substring(0, s1);
        String payload = "{\"ph\":" + linea.substring(s1 + 1, s2) +
                         ",\"temp_ambiente\":" + linea.substring(s2 + 1, s3) +
                         ",\"temp_agua\":" + linea.substring(s3 + 1);
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
            Serial.printf("[SD] Error reenvío HTTP %d\n", code);
            break;
        }
    }
    f.close();
    Serial.printf("[SD] Reenvío: %d OK, %d errores\n", enviados, errores);
    if (errores == 0)
    {
        SD.remove(SD_ARCHIVO);
        Serial.println("[SD] Archivo borrado.");
    }
    xSemaphoreGive(xMutexSD);
}

// ═══════════════════════════════════════════════════════════════
//  LECTURAS DE SENSORES
// ═══════════════════════════════════════════════════════════════
float leerTemperaturaAmbiente()
{
    if (!SENSOR_DHT22_INSTALADO)
        return NAN;
    float t = dht.readTemperature();
    if (isnan(t))
        Serial.println("[DHT22] Error → null");
    return t;
}

float leerTemperaturaAgua()
{
    if (!SENSOR_DS18B20_INSTALADO)
        return NAN;
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t == DEVICE_DISCONNECTED_C || t <= -126.0f)
    {
        Serial.println("[DS18B20] Error → null");
        return NAN;
    }
    return t;
}

float leerPH()
{
    if (!SENSOR_PH_INSTALADO)
        return NAN;
    long suma = 0;
    for (int i = 0; i < 10; i++)
    {
        suma += analogRead(PIN_PH);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    float v = ((float)suma / 10) * (3.3f / 4095.0f);
    float pendiente = (4.0f - 7.0f) / (PH_VOLTAJE_4 - PH_VOLTAJE_7);
    return constrain(7.0f + pendiente * (v - PH_VOLTAJE_7), 0.0f, 14.0f);
}

// ═══════════════════════════════════════════════════════════════
//  TAREAS FREERTOS
// ═══════════════════════════════════════════════════════════════

// ── Tarea 1: Lectura de sensores (Core 1, prioridad 3) ────────
//
// Ciclo: adquiere xLockSensores → lee sensores → libera lock →
//        actualiza shared data → notifica tarea_comunicacion →
//        duerme INTERVALO_MEDICION_MS (CPU entra en Light Sleep).
//
// Por qué el lock:
//   DS18B20 usa 1-Wire con slots de 1 µs/bit. DHT22 usa señales de
//   18 ms (inicio) + pulsos de 26-70 µs (datos). Si el PM interrumpe
//   cualquiera de estos pulsos, la trama queda corrupta y el sensor
//   devuelve DEVICE_DISCONNECTED o NAN. xLockSensores con tipo
//   ESP_PM_NO_LIGHT_SLEEP garantiza que el CPU no duerme entre
//   adquirir y liberar el lock.
//
void tarea_sensores(void *param)
{
    while (true)
    {
        // ── Zona crítica de temporización ──────────────────────
        esp_pm_lock_acquire(xLockSensores);

        float ph = leerPH();
        float t_amb = leerTemperaturaAmbiente();
        float t_agua = leerTemperaturaAgua();

        esp_pm_lock_release(xLockSensores);
        // ── Fin zona crítica ───────────────────────────────────

        xSemaphoreTake(xMutexDatos, portMAX_DELAY);
        ultimaLectura.ph = ph;
        ultimaLectura.t_amb = t_amb;
        ultimaLectura.t_agua = t_agua;
        xSemaphoreGive(xMutexDatos);

        Serial.printf("[Sensores] pH:%s T_amb:%s T_agua:%s\n",
                      fmtVal(ph).c_str(), fmtVal(t_amb).c_str(), fmtVal(t_agua).c_str());

        digitalWrite(LED_PH, isnan(ph) ? HIGH : LOW);
        digitalWrite(LED_TEMP_AMB, isnan(t_amb) ? HIGH : LOW);
        digitalWrite(LED_TEMP_AGUA, isnan(t_agua) ? HIGH : LOW);

        // ── Despertar a tarea_comunicacion ─────────────────────
        // xTaskNotifyGive incrementa el contador de notificaciones
        // de xHandleComunic. Si la tarea ya estaba en
        // ulTaskNotifyTake(portMAX_DELAY), despierta inmediatamente.
        // Si no (caso de startup lento), la notificación queda
        // encolada y se procesa en la próxima llamada a Take.
        xTaskNotifyGive(xHandleComunic);

        // Durante este delay todas las tareas estarán en espera →
        // FreeRTOS idle hook → Power Manager → Light Sleep automático.
        vTaskDelay(INTERVALO_MEDICION_MS);
    }
}

// ── Tarea 2: Comunicación HTTP + SD (Core 1, prioridad 2) ─────
//
// Duerme indefinidamente en ulTaskNotifyTake hasta que tarea_sensores
// la despierta. Esto elimina el timer propio de 10 min que existía
// antes: ahora hay exactamente 1 wakeup de CPU por ciclo de medición
// (el de tarea_sensores), no 2.
//
// Por qué xLockHTTP en ESP_PM_APB_FREQ_MAX:
//   El stack WiFi internamente usa el bus APB para acceder al módulo
//   de RF. Si el PM baja APB a 40 MHz en medio de un TCP handshake,
//   los timers del MAC se desfasan y la conexión puede caer con
//   error -11 (EAGAIN) o timeout. El lock lo previene.
//
void tarea_comunicacion(void *param)
{
    while (true)
    {
        // ── Dormir hasta ser notificado por tarea_sensores ──────
        // pdTRUE: limpia el contador tras recibirlo (semáforo binario).
        // portMAX_DELAY: espera sin límite de tiempo.
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        reconectarWiFi();

        xSemaphoreTake(xMutexDatos, portMAX_DELAY);
        float ph = ultimaLectura.ph;
        float t_amb = ultimaLectura.t_amb;
        float t_agua = ultimaLectura.t_agua;
        xSemaphoreGive(xMutexDatos);

        String fechaHora = obtenerFechaHora();
        String payload = "{\"ph\":" + fmtVal(ph) +
                         ",\"temp_ambiente\":" + fmtVal(t_amb) +
                         ",\"temp_agua\":" + fmtVal(t_agua);
        if (fechaHora.length() > 0)
            payload += ",\"fecha_hora\":\"" + fechaHora + "\"";
        payload += "}";

        if (WiFi.status() == WL_CONNECTED)
        {
            // ── Adquirir lock APB antes de cualquier operación HTTP ─
            // Cubre tanto reenviarDesdeSD() como el POST principal,
            // evitando adquirir/liberar el lock dos veces seguidas.
            esp_pm_lock_acquire(xLockHTTP);

            reenviarDesdeSD(); // Reenvío de pendientes primero

            HTTPClient http;
            http.begin(URL_MEDICIONES);
            http.addHeader("Content-Type", "application/json");
            int codigo = http.POST(payload);
            http.end();

            esp_pm_lock_release(xLockHTTP);
            // ── Fin zona HTTP ──────────────────────────────────

            if (codigo == 201)
                Serial.printf("[HTTP] OK | %s | pH:%s T_amb:%s T_agua:%s\n",
                              fechaHora.c_str(), fmtVal(ph).c_str(),
                              fmtVal(t_amb).c_str(), fmtVal(t_agua).c_str());
            else
            {
                Serial.printf("[HTTP] Error (%d) → SD\n", codigo);
                guardarEnSD(ph, t_amb, t_agua);
            }
        }
        else
        {
            Serial.println("[WiFi] Sin conexión → SD");
            guardarEnSD(ph, t_amb, t_agua);
        }

        // Sin vTaskDelay: la tarea vuelve inmediatamente a
        // ulTaskNotifyTake y el CPU queda libre para Light Sleep.
    }
}

// ── Tarea 3: Actualización de umbrales (Core 0, prioridad 1) ──
// Consulta el servidor cada 30 s para reflejar cambios del docente.
void tarea_umbrales(void *param)
{
    while (true)
    {
        if (WiFi.status() == WL_CONNECTED)
        {
            float ph_min, ph_max, ta_min, ta_max, tw_min, tw_max;
            bool ok = true;

            // ── Adquirir lock APB para las 3 consultas GET ─────
            esp_pm_lock_acquire(xLockHTTP);

            auto consultarUmbral = [&](const char *var, float &mn, float &mx) -> bool
            {
                HTTPClient http;
                http.begin(String(URL_UMBRALES) + "/" + var);
                int code = http.GET();
                if (code == 200)
                {
                    String body = http.getString();
                    int iMin = body.indexOf("\"minimo\":") + 9;
                    int iMax = body.indexOf("\"maximo\":") + 9;
                    if (iMin > 9 && iMax > 9)
                    {
                        mn = body.substring(iMin, body.indexOf(',', iMin)).toFloat();
                        mx = body.substring(iMax, body.indexOf('}', iMax)).toFloat();
                        http.end();
                        return true;
                    }
                }
                http.end();
                return false;
            };

            ok &= consultarUmbral("ph", ph_min, ph_max);
            ok &= consultarUmbral("temp_ambiente", ta_min, ta_max);
            ok &= consultarUmbral("temp_agua", tw_min, tw_max);

            esp_pm_lock_release(xLockHTTP);
            // ── Fin zona HTTP ──────────────────────────────────

            if (ok)
            {
                xSemaphoreTake(xMutexDatos, portMAX_DELAY);
                umbrales.ph_min = ph_min;
                umbrales.ph_max = ph_max;
                umbrales.t_amb_min = ta_min;
                umbrales.t_amb_max = ta_max;
                umbrales.t_agua_min = tw_min;
                umbrales.t_agua_max = tw_max;
                umbrales.cargados = true;
                xSemaphoreGive(xMutexDatos);
                Serial.printf("[Umbrales] pH:[%.1f-%.1f] T.Amb:[%.1f-%.1f] T.Agua:[%.1f-%.1f]\n",
                              ph_min, ph_max, ta_min, ta_max, tw_min, tw_max);
            }
        }
        vTaskDelay(INTERVALO_UMBRALES_MS);
    }
}

// ── Tarea 4: Control del LED naranja (Core 0, prioridad 1) ────
// · Sensor null    → titila cada 500 ms
// · Fuera de rango → encendido fijo
// · Todo normal    → apagado
void tarea_led_umbral(void *param)
{
    bool estadoParpadeo = false;

    while (true)
    {
        xSemaphoreTake(xMutexDatos, portMAX_DELAY);
        float ph = ultimaLectura.ph;
        float t_amb = ultimaLectura.t_amb;
        float t_agua = ultimaLectura.t_agua;
        Umbrales u = umbrales;
        xSemaphoreGive(xMutexDatos);

        bool hayNull = isnan(ph) || isnan(t_amb) || isnan(t_agua);

        if (hayNull)
        {
            estadoParpadeo = !estadoParpadeo;
            digitalWrite(LED_UMBRAL, estadoParpadeo ? HIGH : LOW);
        }
        else
        {
            bool fueraDeRango =
                (ph < u.ph_min || ph > u.ph_max) ||
                (t_amb < u.t_amb_min || t_amb > u.t_amb_max) ||
                (t_agua < u.t_agua_min || t_agua > u.t_agua_max);

            if (fueraDeRango)
            {
                digitalWrite(LED_UMBRAL, HIGH);
                estadoParpadeo = true;
            }
            else
            {
                digitalWrite(LED_UMBRAL, LOW);
                estadoParpadeo = false;
            }
        }

        vTaskDelay(INTERVALO_PARPADEO_MS);
    }
}

// ═══════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════
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
    Serial.printf("[DS18B20] Sensores en el bus: %d\n", ds18b20.getDeviceCount());

    // ── MicroSD ────────────────────────────────────────────────
    spiSD.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
    if (SD.begin(SD_CS, spiSD, 1000000))
    {
        sdDisponible = true;
        Serial.println("[SD] Inicializada.");
    }
    else
    {
        Serial.println("[SD] ADVERTENCIA: No inicializada. Respaldo deshabilitado.");
    }

    // ── WiFi ───────────────────────────────────────────────────
    WiFi.begin(SSID, WIFI_PASS);
    Serial.print("[WiFi] Conectando");
    unsigned long t = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t < 10000)
    {
        delay(500);
        Serial.print(".");
    }
    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("\n[WiFi] Conectado. IP: " + WiFi.localIP().toString());
        sincronizarNTP();
    }
    else
    {
        Serial.println("\n[WiFi] Sin conexión inicial.");
    }

    // ── Power Management ───────────────────────────────────────
    //
    // WIFI_PS_MIN_MODEM: el módulo RF apaga su transmisor entre
    // ventanas de transmisión (DTIM beacons). Reduce ~40% el consumo
    // del módulo WiFi sin perder la conexión al AP.
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

    // Light Sleep automático del CPU:
    //   - max_freq_mhz = 240: frecuencia máxima cuando hay carga.
    //   - min_freq_mhz = 40:  frecuencia mínima en idle (aporox. 40 MHz
    //     es el mínimo estable con WiFi conectado en ESP32).
    //   - light_sleep_enable = true: cuando FreeRTOS entra en idle
    //     (todas las tareas en vTaskDelay o ulTaskNotifyTake),
    //     el PM apaga el CPU core, RTC activo y el timer de FreeRTOS
    //     como wake source. Al vencer el próximo tick, despierta solo.
    esp_pm_config_esp32_t pm_config = {
        .max_freq_mhz = 240,
        .min_freq_mhz = 40,
        .light_sleep_enable = true};
    esp_err_t pm_err = esp_pm_configure(&pm_config);
    if (pm_err == ESP_OK)
        Serial.println("[Power] Light Sleep automático habilitado (240/40 MHz).");
    else
        Serial.printf("[Power] ADVERTENCIA: esp_pm_configure error 0x%x\n", pm_err);

    // ── Crear locks de PM ──────────────────────────────────────
    esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "lock_sensores", &xLockSensores);
    esp_pm_lock_create(ESP_PM_APB_FREQ_MAX, 0, "lock_http", &xLockHTTP);
    Serial.println("[Power] Locks PM: xLockSensores (NO_LIGHT_SLEEP), xLockHTTP (APB_MAX).");

    // ── Mutex ─────────────────────────────────────────────────
    xMutexDatos = xSemaphoreCreateMutex();
    xMutexSD = xSemaphoreCreateMutex();

    // ── Crear tareas FreeRTOS ─────────────────────────────────
    //
    // ORDEN CRÍTICO:
    //   tarea_comunicacion se crea PRIMERO y su handle se guarda en
    //   xHandleComunic. Solo después se crea tarea_sensores, que
    //   usará ese handle en xTaskNotifyGive(). Si el orden fuera
    //   inverso, tarea_sensores podría llamar a xTaskNotifyGive(NULL)
    //   antes de que el handle exista → comportamiento indefinido.
    //
    // Parámetros: función, nombre, stack(B), param, prioridad, handle*, núcleo
    xTaskCreatePinnedToCore(tarea_comunicacion, "Comunic", 8192, NULL, 2, &xHandleComunic, 1);
    xTaskCreatePinnedToCore(tarea_sensores, "Sensores", 4096, NULL, 3, NULL, 1);
    xTaskCreatePinnedToCore(tarea_umbrales, "Umbrales", 4096, NULL, 1, NULL, 0);
    xTaskCreatePinnedToCore(tarea_led_umbral, "LED_Umbral", 2048, NULL, 1, NULL, 0);

    Serial.println("[Sistema] FreeRTOS + Light Sleep operativos. Tareas iniciadas.");
}

// ═══════════════════════════════════════════════════════════════
//  LOOP — vacío: FreeRTOS toma el control
// ═══════════════════════════════════════════════════════════════
void loop()
{
    // El loop de Arduino cede el CPU permanentemente al scheduler.
    vTaskDelay(portMAX_DELAY);
}
