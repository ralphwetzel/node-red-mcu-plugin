class XsbugMessageEx {

    constructor(xml) {
		xml = xml.documentElement;
		if ("xsbug" !== xml.nodeName)
			throw new Error("not xsbug xml");
		for (let node = xml.firstChild; node; node = node.nextSibling) {

            if (XsbugMessageEx[node.nodeName]) {
                XsbugMessageEx[node.nodeName](this, node);
            } else {
                XsbugMessage[node.nodeName](this, node);
            }
		}
	}

	static bubble(message, node) {

        message.bubble = { 
            node: node.getAttribute('name'),
            data: node.textContent
        };
	}

}

class XsbugSerial extends XsbugConnection {

    #active;
    #reader;
    #readLoop;

    constructor(options = {}) {
		super();
		this.baud = options.baudRate || 921600;
		this.dst = new Uint8Array(32768);
		// this.connect();

        this.port = options.port
	}

	reset() {
		this.binary = false;
		this.dstIndex = 0;
		this.currentMachine = undefined;
        this.#active = false;
	}

	async connect(device) {

        // https://developer.chrome.com/articles/serial/

        let xs = this;
        await xs.closeDevice();

        async function readUntilClosed(port) {
            while (port.readable && xs.#active) {
                xs.#reader = port.readable.getReader();
                try {
                    while (true) {
                        const { value, done } = await xs.#reader.read();
                        if (done) {
                            // reader.cancel() has been called.
                            break;
                        }
                        // value is a Uint8Array.
                        // console.log(value);
                        xs.usbReceive(value);
                    }
                } catch (error) {
                    console.log(error.toString());
                    // Handle error...
                } finally {
                    // Allow the serial port to be closed later.
                    xs.#reader.releaseLock();
                }
            }
            await port.close();
        }

		try {
			xs.reset();

            if (device) {
                xs.port = device;
            }

            if (!xs.port) {
                await xs.getDevice();
            }

			await xs.openDevice();

            xs.#active = true;
			xs.#readLoop = readUntilClosed(xs.port);

		}
		catch (e) {
			console.log("Connect error: ", e.toString());
		}
	}

    async getDevice() {
        this.port = await navigator.serial.requestPort({});
	}

    async openDevice(baud) {
        baud ??= this.baud;
        await this.port.open({ baudRate: baud });
	}

    async closeDevice() {
        if (this.#readLoop) {
            this.#active = false;
            this.#reader.cancel();
            await this.#readLoop;
        } else {
            return Promise.resolve();
        }
    }

    usbReceive(src) {
        const mxTagSize = 17;

        let dst = this.dst;
        let dstIndex = this.dstIndex;
        let srcIndex = 0, machine;

        while (srcIndex < src.length) {
            if (dstIndex === dst.length) {	// grow buffer
                dst = new Uint8Array(dst.length + 32768);
                dst.set(this.dst);
                this.dst = dst;
            }
            dst[dstIndex++] = src[srcIndex++];

            if (this.binary) {
                if (dstIndex < 2)
                    this.binaryLength = dst[0] << 8;
                else if (2 === dstIndex)
                    this.binaryLength |= dst[1];
                if ((2 + this.binaryLength) === dstIndex) {
                    this.onReceive(dst.slice(2, 2 + this.binaryLength).buffer);

                    dstIndex = 0;
                    this.binary = false;
                    delete this.binaryLength;
                }
            }
            else if ((dstIndex >= 2) && (dst[dstIndex - 2] == 13) && (dst[dstIndex - 1] == 10)) {
                if ((dstIndex >= mxTagSize) && (machine = XsbugSerial.matchProcessingInstruction(dst.subarray(dstIndex - mxTagSize, dstIndex)))) {
                    if (machine.flag)
                        this.currentMachine = machine.value;
                    else
                        this.currentMachine = undefined;
                    this.binary = machine.binary;
                }
                else if ((dstIndex >= 10) && (dst[dstIndex - 10] == '<'.charCodeAt()) &&
                    (dst[dstIndex - 9] == '/'.charCodeAt()) && (dst[dstIndex - 8] == 'x'.charCodeAt()) &&
                    (dst[dstIndex - 7] == 's'.charCodeAt()) && (dst[dstIndex - 6] == 'b'.charCodeAt()) &&
                    (dst[dstIndex - 5] == 'u'.charCodeAt()) && (dst[dstIndex - 4] == 'g'.charCodeAt()) &&
                    (dst[dstIndex - 3] == '>'.charCodeAt())) {
                    const message = new TextDecoder().decode(dst.subarray(0, dstIndex));
                    // console.log(message);
                    this.onReceive(message);
                }
                else {
                    dst[dstIndex - 2] = 0;
                    //@@				if (offset > 2) fprintf(stderr, "%s\n", self->buffer);
                }
                dstIndex = 0;

            }
        }

        this.dstIndex = dstIndex;
    }

	onReceive(data) {
		if ("string" === typeof data) {
			const msg = new XsbugMessageEx((new DOMParser).parseFromString(data, "application/xml"));
			if (msg.break)
				this.onBreak(msg);
			else if (msg.login)
				this.onLogin(msg);
			else if (msg.instruments)
				this.onInstrumentationConfigure(msg);
			else if (msg.local)
				this.onLocal(msg);
			else if (msg.log)
				this.onLog(msg);
			else if (msg.samples)
				this.onInstrumentationSamples(msg);
            else if (msg.bubble)
                this.onBubble(msg);
			else
				debugger;		// unhandled
		}
		else {
			const view = new DataView(data);
			switch (view.getUint8(0)) {
				case 5:
					const id = view.getUint16(1), code = view.getInt16(3);
					const index = this.pending.findIndex(pending => id === pending.id)
					if (index >= 0) {
						const pending = this.pending[index];
						this.pending.splice(index, 1);
						(pending.callback)(code, data.slice(5));
					}
					break;
				default:
					debugger;
					break;
			}
		}
	}


    static matchProcessingInstruction(dst) {
        let flag, binary = false, value = 0;
        if (dst[0] != '<'.charCodeAt())
            return;
        if (dst[1] != '?'.charCodeAt())
            return;
        if (dst[2] != 'x'.charCodeAt())
            return;
        if (dst[3] != 's'.charCodeAt())
            return;
        let c = dst[4];
        if (c == '.'.charCodeAt())
            flag = true;
        else if (c == '-'.charCodeAt())
            flag = false;
        else if (c == '#'.charCodeAt()) {
            flag = true;
            binary = true;
        }
        else
            return;
        for (let i = 0; i < 8; i++) {
            c = dst[5 + i]
            if (('0'.charCodeAt() <= c) && (c <= '9'.charCodeAt()))
                value = (value * 16) + (c - '0'.charCodeAt());
            else if (('a'.charCodeAt() <= c) && (c <= 'f'.charCodeAt()))
                value = (value * 16) + (10 + c - 'a'.charCodeAt());
            else if (('A'.charCodeAt() <= c) && (c <= 'F'.charCodeAt()))
                value = (value * 16) + (10 + c - 'A'.charCodeAt());
            else
                return;
        }
        if (dst[13] != '?'.charCodeAt())
            return;
        if (dst[14] != '>'.charCodeAt())
            return;
        return { value: value.toString(16).padStart(8, "0"), flag, binary };
    }

    async send(data) {
		if ("string" == typeof data) {
			const preamble = XsbugConnection.crlf + `<?xs.${this.currentMachine}?>` + XsbugConnection.crlf;
			data = new TextEncoder().encode(preamble + data);
			// tracePacket("<", data);
            await this.#write(data);
		}
		else {
			let preamble = XsbugConnection.crlf + `<?xs#${this.currentMachine}?>`;
			preamble = new TextEncoder().encode(preamble);
			let payload = new Uint8Array(data);
			let buffer = new Uint8Array(preamble.length + 2 + payload.length);
			buffer.set(preamble, 0);
			buffer[preamble.length] = (payload.length >> 8) & 0xff;
			buffer[preamble.length + 1] = payload.length & 0xff;
			buffer.set(payload, preamble.length + 2);

			// tracePacket("< ", buffer);
            await this.#write(buffer);
		}
	}

    async #write(data) {

        let port = this.port;
        let writer;
        let pass;

        if (!port)
            return Promise.reject(Error("Port is not defined!"));

        while (!pass) {
            if (!port.writable.locked) {
                try {
                    console.log("#write: @get")
                    writer = port.writable.getWriter();
                    console.log("#write: locked")
                    pass = true;    
                } catch (err) {
                    // TypeError: Failed to execute 'getWriter' on 'WritableStream': Cannot create writer when WritableStream is locked
                    if (err instanceof TypeError == false) {
                        // sth else failed.
                        throw(err);
                    }
                }
            }
            
            if (!pass)
                await this.timeout(100);

        }

        writer.write(data);
        writer.releaseLock();
        console.log("#write: released")

    }

    // async write(data) {
        
    //     console.log("@#write")

    //     let port = this.port;

    //     if (port) {

    //         let writer;

    //         let x = new Promise((resolve, reject) => {

    //             // let writer;
    //             let pass;

    //             while (!pass) {
    //                 if (!port.writable.locked) {
    //                     try {
    //                         console.log("#write: @get")

    //                         // despite .locked == false, getWriter could fail!
    //                         writer = port.writable.getWriter();
    //                         pass = true;
    //                     } catch (err) {
    //                         // TypeError: Failed to execute 'getWriter' on 'WritableStream': Cannot create writer when WritableStream is locked
    //                         if (err instanceof TypeError == false) {
    //                             // sth else failed.
    //                             reject(err);
    //                         }
    //                     }
    //                 } else {
    //                     await this.timeout(100);
    //                     console.log("#write: locked")
    //                 }
    //             }
    //             console.log("resolving");
    //             resolve();
    //         }).then(() => {
    //             console.log("#write: writing")

    //             // data shall be an Uint8Array
    //             return writer.write(data);

    //         }).then(() => {

    //             // Allow the serial port to be closed later.
    //             writer.releaseLock();
    //             console.log("#write: released")
    //             return;
    //         })

    //         // return x;

    //     } else {
    //         // should we better resolve here?
    //         return Promise.reject(Error("Port is not defined!"));
    //     }
    // }

    async timeout(ms) {
        return new Promise((resolve) => 
            setTimeout(resolve, ms)
        );
    }

}
