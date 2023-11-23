## node-red-node-serialport

This directory contains a shim for `node-red-node-serialport`.
The code gets - transparently - injected when using `node-red-node-serialport` for an MCU build.

Currently, `Serial In` - node & `Serial Out` - Node are supported.
`Serial Request` - Node is not supported.

The major difference to the standard implementation derives from the demand to define the pin parameters of the serial interface to be used by these nodes.
As the property editor doesn't provide a better option, this pin parameter definition has to be entered as _Serial Port path_, e.g. `/P2/R33/T19`.

<img alt="mcu_example" src="resources/mcu_example.png"
    style="min-width: 474px; width: 474px; align: center; border: 1px solid lightgray;"/>

* `/Px`: Port number
* `/Rx`: Receive (RX) pin number
* `/Tx`: Transmit (TX) pin number

The order of the _path elements_ doesn't matter.

> **Attention**: The default serial interface (Port: 1 / RX: Pin 3 / TX: Pin 1) is [reserved for / occupied by the debugging link between the MCU and Node-RED](https://github.com/Moddable-OpenSource/moddable/issues/1226#issuecomment-1823361637)! Thus you must use a different parameter set (and different hardware pins!) to establish a connection to you serial devices.

This implementaton supports the following properties for a `Serial Port` definition in `node-red-node-serialport`:

- [x] Baud Rate
- [ ] Data Bits, Parity, Stop Bits: According ECMA-419 version 2, always `8-N-1`. 
- [ ] DTR, RTS, CTS, DSR
- [x] Start character
- [x] Split input: character, timeout, silence, length
- [x] Deliver: Binary Buffer, ASCII strings
- [x] Stream of single bytes / chars 
- [ ] Append output character
- [ ] Request response timeout

> This shim may be removed as soon as an implementation of `node-red-node-serialport` is incorporated into core `node-red-mcu`.


