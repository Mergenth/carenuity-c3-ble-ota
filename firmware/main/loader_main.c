/*
 * Carenuity BLE-OTA loader for the ESP32-C3 (C3-Mini).
 *
 * Lives in the factory partition. The custom bootloader starts it after every
 * hard reset. It opens a Bluetooth LE update window; if no phone connects, it
 * software-restarts and the bootloader then starts the installed sketch.
 */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_cpu.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#include "ble_ota.h"

static const char *TAG = "loader";

#define WINDOW_US ((int64_t)CONFIG_LOADER_WINDOW_S * 1000000)

/*
 * Hand over to the installed sketch.
 *
 * A reset of the whole digital core (not only of the CPU) is used on purpose:
 * the sketch is a different program and must not inherit radio, peripheral or
 * memory-protection state from the loader. The bootloader sees a software
 * reset and therefore starts the sketch instead of the loader.
 */
static void __attribute__((noreturn)) start_sketch(void)
{
    vTaskDelay(pdMS_TO_TICKS(50));      /* let the log line out */
    esp_cpu_intr_disable(0xFFFFFFFF);   /* nothing of ours may fire in the sketch */
    esp_rom_software_reset_system();
    for (;;) {
    }
}

static bool button_pressed(void)
{
#if CONFIG_LOADER_BOOT_BUTTON_GPIO >= 0
    return gpio_get_level(CONFIG_LOADER_BOOT_BUTTON_GPIO) == 0;
#else
    return false;
#endif
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

#if CONFIG_LOADER_BOOT_BUTTON_GPIO >= 0
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << CONFIG_LOADER_BOOT_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&btn);
#endif

    ble_ota_start();

    ESP_LOGI(TAG, "Carenuity BLE-OTA loader %s", esp_app_get_description()->version);
    if (ble_ota_have_app()) {
        ESP_LOGI(TAG, "update window open for %d s, then the installed sketch starts",
                 CONFIG_LOADER_WINDOW_S);
    } else {
        ESP_LOGI(TAG, "no sketch installed: waiting for a phone");
    }

    bool stay = false;
    int button_ticks = 0;
    int64_t deadline = esp_timer_get_time() + WINDOW_US;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(50));

        if (ble_ota_boot_requested()) {
            /* Give the last notification time to reach the phone. */
            vTaskDelay(pdMS_TO_TICKS(1200));
            ESP_LOGI(TAG, "starting installed sketch");
            start_sketch();
        }

        /* Debounced: the button has to be down for three samples in a row. */
        button_ticks = button_pressed() ? button_ticks + 1 : 0;
        if (!stay && button_ticks >= 3) {
            stay = true;
            ESP_LOGI(TAG, "BOOT button: staying in update mode until reset");
        }

        if (ble_ota_connected() || ble_ota_busy()) {
            /* Re-arm: after a disconnect the window starts again. */
            deadline = esp_timer_get_time() + WINDOW_US;
            continue;
        }

        if (stay || !ble_ota_have_app()) {
            continue;
        }

        if (esp_timer_get_time() >= deadline) {
            ESP_LOGI(TAG, "update window closed, starting installed sketch");
            start_sketch();
        }
    }
}
