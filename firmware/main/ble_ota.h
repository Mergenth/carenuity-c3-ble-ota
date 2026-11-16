/*
 * Carenuity BLE-OTA protocol, version 1.
 * See docs/PROTOCOL.md for the full description.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define OTA_PROTOCOL_VERSION 1

/* Commands written by the phone to the CONTROL characteristic */
#define OTA_CMD_START  0x01  /* [size u32]                              */
#define OTA_CMD_END    0x02  /* [crc32 u32]                             */
#define OTA_CMD_ABORT  0x03
#define OTA_CMD_BOOT   0x04  /* leave update mode, start installed app  */
#define OTA_CMD_QUERY  0x05  /* ask for an ACK with the current offset  */

/* Events notified by the loader on the CONTROL characteristic */
#define OTA_EVT_READY  0x81  /* [max payload u16][slot size u32]        */
#define OTA_EVT_ACK    0x82  /* [offset u32]                            */
#define OTA_EVT_DONE   0x83
#define OTA_EVT_ERROR  0xE0  /* [code u8][esp_err i32]                  */

/* Error codes carried by OTA_EVT_ERROR */
#define OTA_ERR_BAD_COMMAND   1
#define OTA_ERR_TOO_LARGE     2
#define OTA_ERR_FLASH         3
#define OTA_ERR_CRC           4
#define OTA_ERR_INVALID_IMAGE 5
#define OTA_ERR_BAD_STATE     6
#define OTA_ERR_OVERFLOW      7

/* Start the Bluetooth stack and the OTA worker. */
void ble_ota_start(void);

/* True while a phone is connected. */
bool ble_ota_connected(void);

/* True once a phone has connected at least once since boot. */
bool ble_ota_was_used(void);

/* True while an image transfer is running. */
bool ble_ota_busy(void);

/* True when a sketch is installed and can be started. */
bool ble_ota_have_app(void);

/* Set by the BOOT command: the phone asked to start the installed sketch. */
bool ble_ota_boot_requested(void);
