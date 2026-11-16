/*
 * Carenuity BLE-OTA second-stage bootloader for ESP32-C3.
 *
 * Based on the ESP-IDF default bootloader (Apache-2.0, Espressif Systems).
 *
 * The only change is the boot-partition policy:
 *
 *   - "Hard" resets (power-on, reset button, USB reset) always start the
 *     BLE-OTA loader that lives in the factory partition. The loader opens a
 *     short Bluetooth LE update window and then software-restarts.
 *   - Every other reset (software restart, panic, watchdog, deep-sleep
 *     wake-up, ...) boots the installed sketch selected by otadata.
 *
 * Because the decision is taken here, the installed sketch does not have to
 * contain any OTA code. Any unmodified ESP32-C3 application image works.
 */
#include <stdbool.h>
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "soc/reset_reasons.h"
#include "bootloader_init.h"
#include "bootloader_utility.h"
#include "bootloader_common.h"

static const char *TAG = "boot";

static int select_partition_number(bootloader_state_t *bs);

/* True for resets that a person triggers on purpose: power, reset button, USB. */
static bool is_hard_reset(soc_reset_reason_t reason)
{
    switch (reason) {
    case RESET_REASON_CHIP_POWER_ON:   /* power-on, EN/reset button (also chip brown-out) */
    case RESET_REASON_CORE_USB_UART:   /* reset requested over the USB serial port */
    case RESET_REASON_CORE_USB_JTAG:   /* reset requested over USB JTAG */
        return true;
    default:
        return false;
    }
}

void __attribute__((noreturn)) call_start_cpu0(void)
{
    if (bootloader_init() != ESP_OK) {
        bootloader_reset();
    }

    bootloader_state_t bs = {0};
    int boot_index = select_partition_number(&bs);
    if (boot_index == INVALID_INDEX) {
        bootloader_reset();
    }

    bootloader_utility_load_boot_image(&bs, boot_index);
}

static int select_partition_number(bootloader_state_t *bs)
{
    if (!bootloader_utility_load_partition_table(bs)) {
        ESP_LOGE(TAG, "load partition table error!");
        return INVALID_INDEX;
    }

    /* Standard choice: otadata -> installed sketch, or factory if none. */
    int boot_index = bootloader_utility_get_selected_boot_partition(bs);
    if (boot_index == INVALID_INDEX) {
        return boot_index;
    }

    soc_reset_reason_t reason = esp_rom_get_reset_reason(0);
    if (is_hard_reset(reason) && bs->factory.offset != 0) {
        if (boot_index != FACTORY_INDEX) {
            ESP_LOGI(TAG, "Carenuity OTA: hard reset (reason %d) -> update loader first", (int)reason);
        }
        boot_index = FACTORY_INDEX;
    } else if (boot_index != FACTORY_INDEX) {
        ESP_LOGI(TAG, "Carenuity OTA: reset reason %d -> installed sketch", (int)reason);
    }
    return boot_index;
}

/* Return global reent struct if any newlib functions are linked to bootloader */
struct _reent *__getreent(void)
{
    return _GLOBAL_REENT;
}
