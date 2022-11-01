const EventEmitter = require("events");
// const net = require('node:net'); // <== Node16
const net = require('net');     // <== Node14
const X2JS = require("x2js");

let log = require('loglevel');
log = log.getLogger('mcu-plugin.lib.proxy')

class mcuProxy extends EventEmitter {

    // This code derives from an idea of @phoddie

    constructor(portIn, portOut, relay, trace) {

        super();

        this.portIn = portIn || 5004;
        this.portOut = portOut || 5002;
        this.relay = relay || true;
        this.trace = trace || false;
        this.x2js = new X2JS();

        this.inCache = '';
        this.xsbug;
        this.target;

        console.log("Launching mcuProxy:");
        this.server = net.createServer(target => { 

            this.target = target;

            if (this.trace)
                console.log('mcuProxy: Target connected.');
        
            if (this.relay) {
                // connect to xsbug to be able to relay messages

                try {
                    this.xsbug = net.connect({
                        port: this.portOut,
                        host: "127.0.0.1"
                    });    
                } catch (err) {
                    console.log("- Failed to connect to xsbug: " + err.message);
                    this.xsbug = undefined;
                    return;
                }
                
                let xsbug = this.xsbug;

                xsbug.setEncoding("utf8");
                xsbug.on('lookup', (err, address, family, host) => {
                    if (err) {
                        console.log(`- Connecting to xsbug: Error while trying to resolve ${host}: ` + err.message);
                    } else {
                        console.log(`- Connecting to xsbug: Resolved ${host} to ${address}/${family}.`);
                    }
                });
                xsbug.on("connect", () => {
                    let c = xsbug.address();
                    console.log(`- Connected to xsbug @ ${c.address}:${c.port}/${c.family}.`);
                })
                xsbug.on('ready', data => {
                    while (xsbug.deferred.length)
                        xsbug.write(xsbug.deferred.shift());
                    delete xsbug.deferred;
                });
                xsbug.on('data', data => {
                    // data = JSON.stringify(data);
                    if (this.trace)
                        console.log("mcuProxy: From xsbug => " + data);
                    target.write(data);
                });
                xsbug.on('end', () => {
                    if (this.trace)
                        console.log("mcuProxy: xsbug disconnected.");
                    target.destroy();
                });
                xsbug.on('error', () => {
                    try {
                        this.xsbug.destroy();
                    } catch(err) {}
                    this.xsbug = undefined;
                });
                xsbug.deferred = [];
                xsbug.deferred.push("2");
            }
        
            target.setEncoding("utf8");
            let first = true;
            target.on('data', data => {

                if (this.trace) {
                    console.log("mcuProxy: From Target => " + data + "<===");
                }

                this.inCache += data.toString();

                // parse messages here
                // each message is an XML document
                // status messages are sent in a bubble right message of the form:
                // <xsbug><bubble name="" value="2" path="/Users/hoddie/Projects/moddable/examples/helloworld/main.js" line="18">JSON STATUS MESSAGE HERE</bubble></xsbug>

                let end = -1;
                do {
                    const start = this.inCache.indexOf("<xsbug><bubble");
                    const end = (start < 0) ? -1 : this.inCache.indexOf("</xsbug>", start); 
                    if (end > -1) {
                        const xml = this.inCache.slice(start, end + 8);
                        let doc;
                        try {                            
                            doc = this.x2js.xml2js(xml);
                        }
                        catch (err) {
                            // console.log(xml);
                        }

                        // this logic supports two protocols
                        // #1: 'source' object as property of msg.status/error/warn/...; this protocol has significant overhead!
                        // #2: no 'source' object in msg.status, but node id passed as bubble.name; less overhead!
                        // It's the subscribers task to find the node id in the data emitted!
                        
                        this.inCache = this.inCache.slice(end + 8);
                        if (doc?.xsbug?.bubble) {
                            let bbl = doc.xsbug.bubble;
                            let id = bbl._name?.length > 0 ? bbl._name : undefined;
                            let text = bbl.__text?.length > 0 ? bbl.__text : undefined;

                            if (text) {
                                try {
                                    let msg = JSON.parse(text);
                                    // log.trace(msg);
                                    if (msg.status) {
                                        this.emit("status", msg.status, id)
                                    } else if (msg.input) {
                                        this.emit("input", msg.input, id)
                                    } else if (msg.error) {
                                        this.emit("error", msg.error, id)
                                    } else if (msg.warn) {
                                        this.emit("warn", msg.warn, id)
                                    }
                                } catch (err) {
                                    // log.error(err, _text);
                                }
                            }
                        }    
                    }
                } while (end >= 0)

                if (this.relay && this.xsbug) {
                    let xsbug = this.xsbug;
                    if (xsbug.deferred)
                        xsbug.deferred.push(data);
                    else
                        xsbug.write(data);
                }
                else {
                    if (first) {
                        // first time need to send set-all-breakpoints as xsbug does
                        first = false;
                        target.write('\r\n<set-all-breakpoints><breakpoint path="exceptions" line="0"/></set-all-breakpoints>\r\n');
                    }
                    else {
                        // assume any other messages are a break, so send go. This isn't always corrrect but may always work.
                        target.write('\r\n<go/>\r\n');
                    }
                }
            });
            target.on('end', () => {
                if (this.trace)
                    console.log('mcuProxy: Target disconnected.');
                if (this.xsbug)
                    this.xsbug.destroy();
                    this.xsbug = undefined;
            });
            target.on("error", () => {
                // we should emit an error here...
            });
        });
        
        this.server.listen(this.portIn, () => { 
            let addr = this.server.address()
            console.log(`- Listening for MCU @ ${addr.address}:${addr.port}/${addr.family}`);
        });
    }

    send2mcu(command, flow, node, data) {

        if (this.target) {
            let target = this.target;
            const options = {
                command: command,
                flow: flow,
                id: node,
                data: data
            };
            try {
                target.write(`\r\n<script path="" line="0"><![CDATA[${JSON.stringify(options)}]]></script>\r\n`);
            }
            catch (err) {
                console.log("Error sending command to MCU: " + err.message);
            }
		}
    }

    disconnect() {
        if (this.xsbug) {
            try {
                this.xsbug.destroy();
            } catch {}
        }
        this.xsbug = undefined;

        if (this.target) {
            try {
                this.target.destroy();
            } catch {}
        }
        this.target = undefined;

        if (this.server) {
            try {
                this.server.close();
                this.server.unref();
            } catch {}
        }
        this.server = undefined;

    }
}

module.exports = {
    proxy: mcuProxy
}
