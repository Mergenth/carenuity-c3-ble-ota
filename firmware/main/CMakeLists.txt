idf_component_register(SRCS "loader_main.c" "ble_ota.c"
                    INCLUDE_DIRS "."
                    PRIV_REQUIRES bt app_update nvs_flash esp_driver_gpio esp_timer esp_rom spi_flash)
