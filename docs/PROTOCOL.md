# Carenuity BLE-OTA protocol, version 1

Spoken between the flasher app (GATT client) and the loader on the board (GATT server).
All integers are little-endian.

## GATT

| | UUID | Properties |
| --- | --- | --- |
| Service | `ca2e0001-07a0-4c3b-8f1e-c3b10ad30001` | advertised; name `Carenuity-OTA-XXXX` is in the scan response |
| CONTROL | `ca2e0002-07a0-4c3b-8f1e-c3b10ad30001` | write, notify |
| DATA | `ca2e0003-07a0-4c3b-8f1e-c3b10ad30001` | write without response (write also accepted) |
| INFO | `ca2e0004-07a0-4c3b-8f1e-c3b10ad30001` | read |

**INFO** is a JSON string, for example

```json
{"p":1,"fw":"1.0.0","chip":"ESP32-C3","mtu":517,"max":508,"slot":3145728,"app":"my_sketch","ver":"1.2","busy":0}
```

`p` protocol version, `fw` loader version, `mtu` negotiated ATT MTU, `max` largest data payload
per packet, `slot` size of the app partition, `app`/`ver` installed app (empty if none).
The phone cannot read the MTU itself in a browser, which is why the board reports it.

## Commands (phone writes to CONTROL)

| Byte 0 | Name | Payload | Meaning |
| --- | --- | --- | --- |
| `0x01` | START | `size u32` | begin a transfer of `size` bytes |
| `0x02` | END | `crc32 u32` | all data sent; CRC-32 (zlib) of the whole image |
| `0x03` | ABORT | | drop the transfer |
| `0x04` | BOOT | | leave update mode and start the installed app |
| `0x05` | QUERY | | ask for an ACK with the current offset |

## Events (board notifies on CONTROL)

| Byte 0 | Name | Payload | Meaning |
| --- | --- | --- | --- |
| `0x81` | READY | `max payload u16`, `slot size u32` | answer to START |
| `0x82` | ACK | `offset u32` | this many bytes are written to flash, in order |
| `0x83` | DONE | | image verified and selected; the board restarts into it |
| `0xE0` | ERROR | `code u8`, `esp_err i32` | transfer aborted |

Error codes: 1 bad command, 2 too large, 3 flash error, 4 CRC mismatch, 5 invalid image,
6 bad state, 7 overflow.

## Data packets (phone writes to DATA)

```
[ offset u32 ][ payload … ]        payload ≤ max
```

Bit 31 of `offset` is the **ACK request**: "acknowledge once this packet is in flash".

The loader accepts a packet only if its offset continues the stream exactly (go-back-N).
Anything else is dropped. A dropped packet that carried an ACK request makes the loader send
an ACK with its current offset right away.

## Transfer

1. Phone reads INFO, sends START, waits for READY.
2. Phone sends a window of packets and sets the ACK request on the last one. The window starts
   at 4 packets and grows to 24 while everything arrives.
3. Phone waits for an ACK above the start of the window.
   - ACK equals the end of the window: continue.
   - ACK is lower: packets were lost. Continue from the ACK offset with half the window.
   - No ACK within 3 s: send QUERY and continue from the offset in the answer.
4. After the last ACK the phone sends END. The loader compares the CRC, lets ESP-IDF validate the
   image (chip type, checksum, SHA-256), selects it for boot, notifies DONE and restarts.

The board is never left with a half-written app that it would try to run: if a transfer fails,
the bootloader finds no valid image and the loader stays in update mode after the next reset.
