/*
 * Carenuity BLE-OTA loader: Bluetooth LE service that receives an ESP32-C3
 * application image and writes it to the "app0" (ota_0) partition.
 *
 * Protocol: docs/PROTOCOL.md
 */
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/stream_buffer.h"

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "esp_rom_crc.h"
#include "esp_rom_sys.h"
#include "soc/reset_reasons.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "ble_ota.h"

static const char *TAG = "ble_ota";

/* Largest attribute value a phone may write (Web Bluetooth limit is 512). */
#define OTA_MAX_ATT_VALUE   512
#define OTA_DATA_HEADER     4               /* u32 offset in front of every data packet */
#define OTA_ACK_REQUEST     0x80000000u     /* bit 31 of the offset: ACK after this packet */
#define OTA_RX_BUFFER       (48 * 1024)
#define OTA_WRITE_BLOCK     4096

/* ca2e0001-07a0-4c3b-8f1e-c3b10ad30001 (and 0002..0004), little-endian byte order */
#define OTA_UUID(n) BLE_UUID128_INIT(0x01, 0x00, 0xd3, 0x0a, 0xb1, 0xc3, 0x1e, 0x8f, \
                                     0x3b, 0x4c, 0xa0, 0x07, (n), 0x00, 0x2e, 0xca)
static const ble_uuid128_t s_svc_uuid  = OTA_UUID(0x01);
static const ble_uuid128_t s_ctrl_uuid = OTA_UUID(0x02);
static const ble_uuid128_t s_data_uuid = OTA_UUID(0x03);
static const ble_uuid128_t s_info_uuid = OTA_UUID(0x04);

typedef enum { ST_IDLE, ST_RECEIVING, ST_DONE } ota_state_t;

typedef struct {
    uint8_t cmd;
    uint32_t a;
    uint32_t b;
} ota_cmd_t;

#define CMD_INTERNAL_DISCONNECT 0xF0

static volatile ota_state_t s_state = ST_IDLE;
static volatile uint32_t s_total;       /* image size announced by START            */
static volatile uint32_t s_rx_off;      /* bytes accepted in order (host task)      */
static volatile uint32_t s_written;     /* bytes written to flash (worker task)     */
static volatile bool s_ack_pending;     /* a data packet asked for an ACK ...       */
static volatile uint32_t s_ack_at;      /* ... once this many bytes are in flash    */
static volatile bool s_query;           /* ACK the current offset as soon as possible */
static uint32_t s_crc;
static bool s_end_pending;
static uint32_t s_end_crc;
static uint32_t s_dropped;

static esp_ota_handle_t s_handle;
static bool s_handle_open;
static const esp_partition_t *s_slot;

static StreamBufferHandle_t s_rx;
static QueueHandle_t s_cmds;

static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_ctrl_handle, s_data_handle, s_info_handle;
static uint8_t s_own_addr_type;
static char s_name[32];

static volatile bool s_was_used;
static volatile bool s_have_app;
static volatile bool s_boot_requested;
static char s_app_name[33];
static char s_app_ver[33];

/* ---------------------------------------------------------------- helpers */

static void ota_put32(uint8_t *p, uint32_t v)
{
    p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff;
}

static uint32_t ota_get32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Keep only characters that are safe inside a JSON string. */
static void copy_clean(char *dst, size_t dst_len, const char *src)
{
    size_t n = 0;
    for (; *src && n + 1 < dst_len; src++) {
        char c = *src;
        if (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') {
            dst[n++] = c;
        }
    }
    dst[n] = 0;
}

static uint16_t max_payload(void)
{
    uint16_t mtu = (s_conn != BLE_HS_CONN_HANDLE_NONE) ? ble_att_mtu(s_conn) : 23;
    uint16_t value = (mtu > 3) ? mtu - 3 : 20;
    if (value > OTA_MAX_ATT_VALUE) {
        value = OTA_MAX_ATT_VALUE;
    }
    return value - OTA_DATA_HEADER;
}

static void notify(const uint8_t *data, size_t len)
{
    if (s_conn == BLE_HS_CONN_HANDLE_NONE) {
        return;
    }
    struct os_mbuf *om = ble_hs_mbuf_from_flat(data, len);
    if (om == NULL) {
        ESP_LOGW(TAG, "no buffer for notification");
        return;
    }
    int rc = ble_gatts_notify_custom(s_conn, s_ctrl_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify failed: %d", rc);
    }
}

static void notify_ack(uint32_t offset)
{
    uint8_t m[5] = { OTA_EVT_ACK };
    ota_put32(m + 1, offset);
    notify(m, sizeof(m));
}

static void notify_error(uint8_t code, esp_err_t err)
{
    uint8_t m[6] = { OTA_EVT_ERROR, code };
    ota_put32(m + 2, (uint32_t)err);
    notify(m, sizeof(m));
    ESP_LOGE(TAG, "OTA error %u (%s)", code, esp_err_to_name(err));
}

static void read_installed_app(void)
{
    const esp_partition_t *boot = esp_ota_get_boot_partition();
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_app_desc_t desc;

    s_have_app = false;
    s_app_name[0] = 0;
    s_app_ver[0] = 0;
    if (boot == NULL || running == NULL || boot->address == running->address) {
        return;
    }
    if (esp_ota_get_partition_description(boot, &desc) != ESP_OK) {
        return;
    }
    copy_clean(s_app_name, sizeof(s_app_name), desc.project_name);
    copy_clean(s_app_ver, sizeof(s_app_ver), desc.version);
    s_have_app = true;
}

/* ------------------------------------------------------------- OTA worker */

static void ota_reset(void)
{
    if (s_handle_open) {
        esp_ota_abort(s_handle);
        s_handle_open = false;
    }
    s_state = ST_IDLE;
    s_end_pending = false;
    s_query = false;
    s_ack_pending = false;
}

static void ota_fail(uint8_t code, esp_err_t err)
{
    ota_reset();
    notify_error(code, err);
}

static void cmd_start(uint32_t size)
{
    ota_reset();

    s_slot = esp_ota_get_next_update_partition(NULL);
    if (s_slot == NULL) {
        ota_fail(OTA_ERR_FLASH, ESP_ERR_NOT_FOUND);
        return;
    }
    if (size < 1024 || size > s_slot->size) {
        ota_fail(OTA_ERR_TOO_LARGE, ESP_ERR_INVALID_SIZE);
        return;
    }

    /* The slot is about to be overwritten: whatever was installed is gone. */
    s_have_app = false;

    esp_err_t err = esp_ota_begin(s_slot, OTA_WITH_SEQUENTIAL_WRITES, &s_handle);
    if (err != ESP_OK) {
        ota_fail(OTA_ERR_FLASH, err);
        return;
    }
    s_handle_open = true;

    xStreamBufferReset(s_rx);
    s_total = size;
    s_rx_off = 0;
    s_written = 0;
    s_crc = 0;
    s_dropped = 0;
    s_state = ST_RECEIVING;

    uint8_t m[7] = { OTA_EVT_READY };
    uint16_t mp = max_payload();
    m[1] = mp & 0xff;
    m[2] = mp >> 8;
    ota_put32(m + 3, s_slot->size);
    notify(m, sizeof(m));
    ESP_LOGI(TAG, "start: %u bytes into '%s', payload %u", (unsigned)size, s_slot->label, mp);
}

static void finish(void)
{
    if (s_written != s_total) {
        ota_fail(OTA_ERR_BAD_STATE, ESP_ERR_INVALID_SIZE);
        return;
    }
    if (s_crc != s_end_crc) {
        ESP_LOGE(TAG, "crc mismatch: got %08x, expected %08x", (unsigned)s_crc, (unsigned)s_end_crc);
        ota_fail(OTA_ERR_CRC, ESP_ERR_INVALID_CRC);
        return;
    }

    /* Validates magic, chip type, segment checksum and the appended SHA-256. */
    s_handle_open = false;
    esp_err_t err = esp_ota_end(s_handle);
    if (err != ESP_OK) {
        ota_fail(OTA_ERR_INVALID_IMAGE, err);
        return;
    }
    err = esp_ota_set_boot_partition(s_slot);
    if (err != ESP_OK) {
        ota_fail(OTA_ERR_FLASH, err);
        return;
    }

    s_state = ST_DONE;
    s_end_pending = false;
    read_installed_app();
    ESP_LOGI(TAG, "done: '%s' %s installed (%u bytes, %u packets dropped)",
             s_app_name, s_app_ver, (unsigned)s_total, (unsigned)s_dropped);

    uint8_t m[1] = { OTA_EVT_DONE };
    notify(m, sizeof(m));
    s_boot_requested = true;
}

static void handle_cmd(const ota_cmd_t *c)
{
    switch (c->cmd) {
    case OTA_CMD_START:
        cmd_start(c->a);
        break;
    case OTA_CMD_END:
        if (s_state != ST_RECEIVING) {
            notify_error(OTA_ERR_BAD_STATE, ESP_ERR_INVALID_STATE);
            break;
        }
        s_end_crc = c->a;
        s_end_pending = true;
        break;
    case OTA_CMD_ABORT:
        ota_reset();
        break;
    case CMD_INTERNAL_DISCONNECT:
        if (s_state == ST_RECEIVING) {
            ESP_LOGW(TAG, "phone disconnected during transfer");
            ota_reset();
        }
        break;
    case OTA_CMD_BOOT:
        if (s_have_app && s_state != ST_RECEIVING) {
            s_boot_requested = true;
        } else {
            notify_error(OTA_ERR_BAD_STATE, ESP_ERR_INVALID_STATE);
        }
        break;
    case OTA_CMD_QUERY:
        if (s_state == ST_RECEIVING) {
            s_query = true;
        } else {
            notify_ack(0);
        }
        break;
    default:
        notify_error(OTA_ERR_BAD_COMMAND, ESP_ERR_NOT_SUPPORTED);
        break;
    }
}

static void ota_task(void *arg)
{
    static uint8_t block[OTA_WRITE_BLOCK];
    ota_cmd_t cmd;

    for (;;) {
        TickType_t wait = (s_state == ST_RECEIVING) ? 0 : pdMS_TO_TICKS(100);
        if (xQueueReceive(s_cmds, &cmd, wait) == pdTRUE) {
            handle_cmd(&cmd);
        }
        if (s_state != ST_RECEIVING) {
            continue;
        }

        size_t n = xStreamBufferReceive(s_rx, block, sizeof(block), pdMS_TO_TICKS(10));
        if (n > 0) {
            esp_err_t err = esp_ota_write(s_handle, block, n);
            if (err != ESP_OK) {
                ota_fail(OTA_ERR_FLASH, err);
                continue;
            }
            s_crc = esp_rom_crc32_le(s_crc, block, n);
            s_written += n;
        }

        /* Everything that was accepted so far is in flash. */
        if (s_written == s_rx_off && xStreamBufferIsEmpty(s_rx)) {
            if (s_query || (s_ack_pending && s_written >= s_ack_at)) {
                s_query = false;
                s_ack_pending = false;
                notify_ack(s_written);
            }
            if (s_end_pending) {
                finish();
            }
        }
    }
}

/* ------------------------------------------------------------------- GATT */

static int ctrl_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t buf[16];
    uint16_t len = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len) != 0 || len < 1) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    ota_cmd_t c = { .cmd = buf[0] };
    if (c.cmd == OTA_CMD_START) {
        if (len < 5) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        c.a = ota_get32(buf + 1);
    } else if (c.cmd == OTA_CMD_END) {
        if (len < 5) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        c.a = ota_get32(buf + 1);
    }
    if (xQueueSend(s_cmds, &c, 0) != pdTRUE) {
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return 0;
}

static int data_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    static uint8_t pkt[OTA_MAX_ATT_VALUE];

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint16_t len = 0;
    if (s_state != ST_RECEIVING ||
        ble_hs_mbuf_to_flat(ctxt->om, pkt, sizeof(pkt), &len) != 0 ||
        len <= OTA_DATA_HEADER) {
        return 0;
    }

    uint32_t offset = ota_get32(pkt);
    uint32_t payload = len - OTA_DATA_HEADER;
    bool want_ack = (offset & OTA_ACK_REQUEST) != 0;
    offset &= ~OTA_ACK_REQUEST;

    /* Go-back-N: only the packet that continues the stream is accepted. The
     * phone learns the accepted offset from the next ACK and resends. */
    if (offset != s_rx_off || offset + payload > s_total ||
        xStreamBufferSpacesAvailable(s_rx) < payload) {
        s_dropped++;
        if (want_ack) {
            s_query = true;     /* tell the phone right away where we stand */
        }
        return 0;
    }
    xStreamBufferSend(s_rx, pkt + OTA_DATA_HEADER, payload, 0);
    s_rx_off = offset + payload;
    if (want_ack) {
        s_ack_at = s_rx_off;
        s_ack_pending = true;
    }
    return 0;
}

static int info_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    const esp_app_desc_t *me = esp_app_get_description();
    const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
    char json[256];
    int n = snprintf(json, sizeof(json),
                     "{\"p\":%d,\"fw\":\"%s\",\"chip\":\"ESP32-C3\",\"mtu\":%u,\"max\":%u,"
                     "\"slot\":%u,\"app\":\"%s\",\"ver\":\"%s\",\"busy\":%d}",
                     OTA_PROTOCOL_VERSION, me->version, (unsigned)ble_att_mtu(conn_handle),
                     (unsigned)max_payload(), slot ? (unsigned)slot->size : 0,
                     s_have_app ? s_app_name : "", s_have_app ? s_app_ver : "",
                     s_state == ST_RECEIVING);
    if (n < 0 || n >= (int)sizeof(json)) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    return os_mbuf_append(ctxt->om, json, n) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &s_ctrl_uuid.u,
                .access_cb = ctrl_access,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_ctrl_handle,
            },
            {
                .uuid = &s_data_uuid.u,
                .access_cb = data_access,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                .val_handle = &s_data_handle,
            },
            {
                .uuid = &s_info_uuid.u,
                .access_cb = info_access,
                .flags = BLE_GATT_CHR_F_READ,
                .val_handle = &s_info_handle,
            },
            { 0 },
        },
    },
    { 0 },
};

/* -------------------------------------------------------------------- GAP */

static void advertise(void);

static int gap_event(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            s_was_used = true;
            ESP_LOGI(TAG, "phone connected");

            /* Ask for a fast link: 7.5-15 ms interval, 2M PHY, long packets. */
            struct ble_gap_upd_params p = {
                .itvl_min = 6, .itvl_max = 12, .latency = 0, .supervision_timeout = 400,
            };
            ble_gap_update_params(s_conn, &p);
            ble_gap_set_prefered_le_phy(s_conn, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK, 0);
            ble_gap_set_data_len(s_conn, 251, 2120);
        } else {
            advertise();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT: {
        ESP_LOGI(TAG, "phone disconnected (reason %d)", event->disconnect.reason);
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        ota_cmd_t c = { .cmd = CMD_INTERNAL_DISCONNECT };
        xQueueSend(s_cmds, &c, 0);
        advertise();
        break;
    }

    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        break;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "mtu %d", event->mtu.value);
        break;

    default:
        break;
    }
    return 0;
}

static void advertise(void)
{
    struct ble_hs_adv_fields adv = { 0 };
    adv.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    adv.uuids128 = &s_svc_uuid;
    adv.num_uuids128 = 1;
    adv.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&adv);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields: %d", rc);
        return;
    }

    struct ble_hs_adv_fields rsp = { 0 };
    rsp.name = (const uint8_t *)s_name;
    rsp.name_len = strlen(s_name);
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGE(TAG, "scan response: %d", rc);
        return;
    }

    struct ble_gap_adv_params params = { 0 };
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    params.itvl_min = BLE_GAP_ADV_ITVL_MS(30);
    params.itvl_max = BLE_GAP_ADV_ITVL_MS(50);
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv start: %d", rc);
    }
}

static void on_sync(void)
{
    uint8_t addr[6] = { 0 };

    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &s_own_addr_type);
    ble_hs_id_copy_addr(s_own_addr_type, addr, NULL);

    snprintf(s_name, sizeof(s_name), "%s-%02X%02X", CONFIG_LOADER_NAME_PREFIX, addr[1], addr[0]);
    ble_svc_gap_device_name_set(s_name);
    ESP_LOGI(TAG, "advertising as '%s'", s_name);
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "bluetooth host reset: %d", reason);
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* ------------------------------------------------------------- public API */

void ble_ota_start(void)
{
    read_installed_app();

    /* The bootloader starts this loader after hard resets only. If we run
     * after any other reset, the bootloader tried the installed sketch and
     * found it unbootable, so there is nothing to hand over to. */
    soc_reset_reason_t reason = esp_rom_get_reset_reason(0);
    bool hard = (reason == RESET_REASON_CHIP_POWER_ON ||
                 reason == RESET_REASON_CORE_USB_UART ||
                 reason == RESET_REASON_CORE_USB_JTAG);
    if (s_have_app && !hard) {
        ESP_LOGW(TAG, "installed sketch did not boot (reset reason %d)", (int)reason);
        s_have_app = false;
    }

    s_rx = xStreamBufferCreate(OTA_RX_BUFFER, 1);
    s_cmds = xQueueCreate(8, sizeof(ota_cmd_t));
    xTaskCreate(ota_task, "ota", 6144, NULL, 5, NULL);

#if CONFIG_LOADER_EMULATOR_TEST
    ESP_LOGW(TAG, "emulator test build: Bluetooth disabled");
    return;
#endif

    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ESP_ERROR_CHECK(ble_gatts_count_cfg(s_gatt_svcs));
    ESP_ERROR_CHECK(ble_gatts_add_svcs(s_gatt_svcs));

    nimble_port_freertos_init(host_task);
}

bool ble_ota_connected(void)      { return s_conn != BLE_HS_CONN_HANDLE_NONE; }
bool ble_ota_was_used(void)       { return s_was_used; }
bool ble_ota_busy(void)           { return s_state == ST_RECEIVING; }
bool ble_ota_have_app(void)       { return s_have_app; }
bool ble_ota_boot_requested(void) { return s_boot_requested; }
