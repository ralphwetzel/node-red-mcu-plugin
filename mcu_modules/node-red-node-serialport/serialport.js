/*
    node-red-node-serialport / Shim by @ralphwetzel
    Copyright 2022 - 2023 Ralph Wetzel
    https://github.com/ralphwetzel/node-red-mcu-plugin
    License: MIT
*/

import { Node } from "nodered";
import Serial from "embedded:io/serial";

// Configuration Node
class mcuSerialPort extends Node {

    static type = "serial-port";

    // read_buffer = new Buffer(0);
    #read_timeout;
    #inter_timeout;

    onStart(config) {
        super.onStart(config);
        let self = this;

        self.listeners = [];
        self.read_buffer = undefined;

        self.newline = config.newline; /* overloaded: split character, timeout, or character count */
        self.addchar = config.addchar || "";
        self.serialbaud = parseInt(config.serialbaud) || 57600;
        self.databits = 8 // NOT SUPPORTED! parseInt(config.databits) || 8;
        self.parity = "none" // config.parity || "none";
        self.stopbits = 1 // parseInt(config.stopbits) || 1;
        self.dtr = "none" // config.dtr || "none";
        self.rts = "none" // config.rts || "none";
        self.cts = "none" // config.cts || "none";
        self.dsr = "none" // config.dsr || "none";
        self.bin = config.bin || "false";
        self.out = config.out || "char";
        self.responsetimeout = config.responsetimeout || 10000;

        let convert = function(input) {
            // from 25-serial.js:
            input = input.replace("\\n","\n");
            input = input.replace("\\r","\r");
            input = input.replace("\\t","\t");
            input = input.replace("\\e","\e");
            input = input.replace("\\f","\f");
            input = input.replace("\\0","\0"); // jshint ignore:line
            if (input.substr(0,2) == "0x") {
                input = parseInt(input,16);
            } else {
                if (input.length > 0) {
                    input = input.charCodeAt(0);
                }
            }
            console.log(input);
            return input;
        }

        self.waitfor = convert(config.waitfor);
        self.addchar = convert(config.addchar) || "";
        self.newline = ("count" == self.out) ? Number(self.newline) : convert(config.newline);

        let parts = config.serialport.split("/");
        let res = {
            "P": 1,
            "T": 1,
            "R": 3
        };

        console.log("parsing port", parts);
        
        Object.keys(res).forEach( k => {
            console.log(k);
            for (let i=0; i<parts.length; i++) {
                if (parts[i]?.[0] == k) {
                    res[k] = parseInt(parts[i].substring(1));
                    console.log(k, res[k]);
                    break;
                }
            }
        })

        // We're not using Buffer.concat from nodered.c here,
        // as this creates a Buffer object,
        // that seems to have an issue in the indexOf function!
        let concat = function(b1, b2) {
            let buf = new Uint8Array(b1.length + b2.length);
            buf.set(b1);
            buf.set(b2, b1.length);
            return buf;
        }

        let send_buffer = function(data) {

            if (!data) {
                return;
            }

            if (!Array.isArray(data)) {
                data = [data];
            }

            if (self.bin !== "bin") {
                for (let i=0;i<data.length;i++) {
                    data[i] = String.fromCharCode(...data[i]);
                }
            }

            // let msg = {}
            // msg._msgid ??= RED.util.generateId();
            // msg.payload = data;

            self.listeners.forEach(l => {
                data.forEach( (d) => {
                    let msg = {};
                    msg._msgid ??= RED.util.generateId();
                    msg.payload = d;
                    RED.mcu.enqueue(msg, l);         
                })
            })
        }

        let processor = {
            "char": function (buf) {

                let forward = [];
                let start = 0;
                let split;

                if (self.read_buffer?.length) {
                    buf = concat(self.read_buffer, buf);
                }
                let length = buf.length;

                console.log(self.newline);

                do {
                    split = buf.indexOf(self.newline, start);
                    if (split > -1) {
                        forward.push(buf.slice(start, split));
                        start = split + 1;
                    }
                } while (split > -1 && start < length)

                self.read_buffer = (start < length) ? new Uint8Array(buf.buffer, start) : undefined;
                if (forward.length > 0) {
                    send_buffer(forward);
                }
            },
            "count": function(buf) {

                let forward = [];
                let start = 0;

                if (self.read_buffer?.length) {
                    buf = concat(self.read_buffer, buf);
                }
                let length = buf.length;

                while (start + self.newline < length) {
                    forward.push(buf.slice(start, start + self.newline));
                    start += self.newline;
                }

                self.read_buffer = (start < length) ? new Uint8Array(buf.buffer, start) : undefined;

                if (forward.length > 0) {
                    send_buffer(forward);
                }
            },
            "time": function(buf) {

                if (self.read_buffer?.length) {
                    self.read_buffer = concat(self.read_buffer, buf);
                } else {
                    self.read_buffer = buf;
                }

                if (!self.#read_timeout) {
                    self.#read_timeout = setTimeout(function () {
                        self.#read_timeout = undefined;
                        let forward = self.read_buffer;
                        self.read_buffer = undefined;
                        send_buffer([forward]);
                    }, self.newline);
                }
            },
            "interbyte": function (buf) {

                if (self.read_buffer?.length) {
                    self.read_buffer = concat(self.read_buffer, buf);
                } else {
                    self.read_buffer = buf;
                }

                if (self.#read_timeout) {
                    clearTimeout(self.#read_timeout);
                }
                self.#read_timeout = setTimeout(function () {
                    self.#read_timeout = undefined;
                    let forward = self.read_buffer;
                    self.read_buffer = undefined;
                    send_buffer([forward]);
                }, self.newline); 
            },
            "pass": function (buf) {
                // send_buffer will split this array into single elements!
                send_buffer(buf);
            }
        }

        // configure the processor!
        let process_on_read = processor[self.out] ?? function () {}
        if (self.newline == 0 || self.newline == "") {
            process_on_read = processor["pass"];            
        }

        // let read_into_buffer = function (count) {
        //     process_on_read(new Uint8Array(this.read()));
        // }

        // let find_start_char = function (count) {
        //     let buf = new Uint8Array(this.read());
        //     let start = buf.indexOf(self.waitfor);

        //     if (start > -1) {
        //         if (self.serial) {
        //             self.serial.onReadable = read_into_buffer;
        //         }
        //         if (buf.length > start + 1) {
        //             process_on_read(buf.slice(start + 1));
        //         }
        //     }
        // }

        self.serial = new device.io.Serial({
            ...device.Serial.default,
            baud: parseInt(config.serialbaud) || 115200,
            port: res.P,
            receive: res.R,
            transmit: res.T,
            format: "buffer",
            onReadable: function (count) {
                let buf = new Uint8Array(this.read());
                if (self.waitfor) {
                    let start = buf.indexOf(self.waitfor);
                    if (start > -1) {
                        self.waitfor = undefined;
                        if (buf.length > start + 1) {
                            process_on_read(buf.slice(start + 1));
                        }
                    }
                    return;
                }
                process_on_read(buf);
            }
        });

        // self.serial.onReadable = self.waitfor ? find_start_char : read_into_buffer;

        self.register_listener = function(id) {
            let n = RED.nodes.getNode(id);
            if (n) {
                self.listeners.push(n);
            }
        }

        self.write = function(buf) {
            try {
                self.serial.write(buf);
            } catch {}
        }
    }

    static {
        RED.nodes.registerType(this.type, this);
    }

}


class mcuSerialOut extends Node {

    static type = "serial out";

    onStart(config) {
        super.onStart(config);
        this.serialConfig = config.serial;
    }

    onMessage(msg, done) {

        let self = this;

        if (!self.serial) {
            self.serial = RED.nodes.getNode(this.serialConfig);
        }

        if (self.serial) {
            self.serial.write(ArrayBuffer.fromString(msg.payload));
        }

        done();
    }

    static {
        RED.nodes.registerType(this.type, this);
      }

}

class mcuSerialIn extends Node {

    static type = "serial in";

    onStart(config) {
        super.onStart(config);
        this.serialConfig = config.serial;

        console.log(this.serialConfig);
        this.serial = RED.nodes.getNode(this.serialConfig);
        if (this.serial) {
            console.log("reg_list", this.id)
            this.serial.register_listener(this.id);
        }
    }

    onMessage(msg, done) {
        this.send(msg);
        done();
    }


    static {
        RED.nodes.registerType(this.type, this);
      }

}